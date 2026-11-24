# Agent Workspace: build plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** replace the Agents and Agent Teams rail tabs with one tab, Agent Workspace: an org tree of teams and agents,
with a team, an agent or "Needs you" on the right.

**Architecture:** pure functions in `hud/src/data/workspace.ts` turn the two caches the tabs already read
(`persona/teams/`, `brain/_index/agents.json`) into a tree, an activity feed, an item order and an agent's seats; thin
view files under `hud/src/views/workspace/` render them and write only through `aos team` / `aos agents`, as today.
One runtime verb, `aos team new`, behind a new `team-create` surface.

**Tech stack:** HUD in TypeScript (`node:test` via tsx, `npm test` in `hud/`); runtime in Node ≥ 20 CommonJS
(`node:test`); app e2e in Playwright (`cd app && npm run test:e2e`).

**Spec:** `docs/design/specs/2026-11-12-agent-workspace-design.md` (D1–D19, A1). Built on `feat/agent-workspace` in the
worktree `~/AgenticOS-Workbench.worktrees/agent-workspace`, base `286da6c0` (2.7.0).

## Global constraints

- Tab id stays `agent-teams`; `agents` is an alias (D3). Label "Agent Workspace", icon `bot`, rail section 1 after `chat` (D2).
- Every write goes through `aos team` / `aos agents`; the HUD never writes a team or agent file (D16, agent-teams D3).
- No model call, hook, MCP tool or transcript read (§5). No new runtime dependency.
- The agent and settings panes have no text box (`noTextBoxes.test.ts`); the channel box and the New team name field are data entry.
- CSS classes `.aos-aw-*`; `--udx-*` tokens only (`npm run check:hex` stays clean).
- Tour steps and What's new use `since: "2.8.0"`; every CHANGELOG Added/Changed bullet carries a `<!-- tour: … -->` or `<!-- no-tour: … -->` marker.
- Never run a test file with bare `node --test` (it writes into the real vault): `npm test`, or `--require ./tools/test-env.js`.
- Commits authored as the GitHub login with its noreply address; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` only.

## Review focus

1. **A broken `TEAM.md`** (the fixtures' `broken` team): the tree lists it with a rose `!`, its pane is the error card with Open TEAM.md, and every other team, the bench and the badge still work. Pinned in Task 5 and Task 9.
2. **No agents cache yet** (`scannedAt: null`) while teams exist: members show by member name, BENCH reads "not scanned yet — sync now", an agent profile falls back to its seat. Pinned in Task 5.
3. **A parent that is missing or a cycle** (`parent` naming no team, or a→b→a): every team appears exactly once (`orderTeams` already lists unreachable teams at depth 0). Pinned in Task 5.
4. **One agent in two teams, lead of one:** it shows under both, is not on the bench, and Remove from the lead's team shows the runtime's refusal. Pinned in Task 5 and Task 12.
5. **A long or torn board history** (2,000 rows; a half-written last line): Activity sorts newest first, shows 50, and a torn line makes no event. Pinned in Task 3.

---

## File structure

| File | PR | New / changed | What |
|---|---|---|---|
| `docs/design/specs/2026-11-12-agent-workspace-design.md`, this plan | 1 | new | committed first |
| `brain/scripts/lib/teams.js`, `brain/scripts/team.js` | 1 | changed | `memberIdFor`, `newTeam`; the `new` verb, its flags and usage line |
| `brain/scripts/test/teams.test.js` | 1 | changed | `newTeam` and the CLI |
| `plugin/commands/team.md`, `codex-plugin/**` | 1 | changed | the `new` verb; Codex plugin rebuilt |
| `app/src/shared/surfaces.ts`, `app/tests/unit/write-policy.test.ts`, `SECURITY.md` | 1 | changed | the `team-create` surface, `verified: false` (D14) |
| `hud/src/data/teamWriter.ts` (+ test) | 1 | changed | `teamIdFrom`, `newTeamArgs` |
| `hud/src/data/teams.ts` (+ test) | 1 | changed | `Team.history` |
| `hud/src/data/workspace.ts`, `workspace.test.ts` | 1 | new | activity, item order, stage strip, tree, seats, bench, runs, node pick |
| `hud/src/settingsDefaults.ts` (+ test) | 2 | changed | `agentWorkspace` choice |
| `hud/src/views/WorkbenchView.ts`, `hud/main.ts`, `hud/src/views/pulse/actions.ts`, `hud/src/ui/PulsePopup.ts` | 2 | changed | rail move, alias, `node` reveal, palette names, Pulse's per-team link |
| `hud/src/views/AgentWorkspaceTab.ts` | 2 | new | header, refresh, timers, selection, the two panes |
| `hud/src/views/workspace/{Tree,NeedsPane,TeamPane,ActivityPane,ItemsPane,SettingsPane,AgentPane}.ts` | 2 | new | one pane each |
| `hud/src/ui/NewTeamModal.ts` | 2 | new | name, derived id, lead, parent |
| `hud/src/views/teams/BoardPane.ts`, `InteractPane.ts`, `ui.ts` | 2 | changed | export `renderItemDetail`; `TeamsView` becomes `"activity" \| "items" \| "channel" \| "settings"` and `VIEWS` goes; BoardPane's `select(…, "board")` → `"items"`, `"interact"` → `"channel"` |
| `hud/src/views/AgentsTab.ts`, `AgentTeamsTab.ts`, `teams/RosterPane.ts`, `teams/ManagePane.ts` | 2 | removed | replaced (D17); `addable` moves to `data/agents.ts` |
| `hud/src/ui/noTextBoxes.test.ts` | 2 | changed | `AgentPane.ts`, `SettingsPane.ts` in Manage's place |
| `hud/styles.css` | 2 | changed | `.aos-aw-*`; `.aos-at-*` kept only where reused panes use it |
| `hud/src/tour/steps.json`, `steps.ts`, `whatsnew.json` | 2 | changed | one `agent-workspace` chapter, `TOUR_TABS`, the 2.8.0 card |
| `app/tests/e2e/agent-workspace.spec.ts` | 2 | new | replaces `agent-teams.spec.ts` and the Agents half of `skills-agents.spec.ts` |
| `app/tests/e2e/{shell,teams-writes,variants,sharing-writes,tab-layout}.spec.ts`, `harness.ts`, `app/scripts/smoke-packaged.mjs` | 2 | changed | rail order, selectors, a `team-create` write test |
| `app/tests/e2e/COVERAGE.md`, `docs/app-smoke.md`, `CHANGELOG.md` | 2 | changed | AW rows replace AT/AG; one smoke section; `[Unreleased]` |
| `README.md`, `docs/assets/screens/agent-workspace.png`, `plugin/commands/agents.md`, `vault-template/persona/teams/example/TEAM.md` | 3 | changed | docs and text name the new tab |

---

## PR 1: data and runtime (`feat: the data behind Agent Workspace, and aos team new`)

### Task 1: `aos team new` in the runtime

**Files:** Modify `brain/scripts/lib/teams.js` (addMember :451, exports :648), `brain/scripts/team.js` (USAGE :15-30,
VALUE :32, a `case 'new'` beside `init` :243). Test `brain/scripts/test/teams.test.js`.

**Interfaces:** Produces `memberIdFor(teamId: string, agent: string): string` (addMember's derivation, moved) and
`newTeam(root, { id, name, lead, parent = null, templatesDir, env = process.env, claudeDir, codexDir, now = new Date() })
→ { team, member, agent, dir }`, both exported. CLI: `aos team new <id> --name <text> --lead <agent> [--parent <team>]`.

- [ ] **Step 1: Write the failing tests** in `teams.test.js`, reusing `world()`, `INTERACTIVE`, `HEADLESS` and the temp agents dirs of the members test:
  - `new: a team with the picked lead as its only member, the template's gates and budget, parsed back by readTeam`:
    `T.newTeam(w.root, { id: 'field', name: 'Field Research', lead: 'dev-writer', templatesDir: TEMPLATES, env: INTERACTIVE, ...dirs })`
    deep-equals `{ team: 'field', member: 'dev-writer', agent: 'dev-writer', dir: path.join(w.root, 'field') }`; `T.readTeam(w.root, 'field')` has
    `name === 'Field Research'`, `lead === 'dev-writer'`, `gates` deep-equal `['discuss', 'ship']`, `budget.default === 10`, one member with
    `role === 'Team lead'`, `stage` `['all']`, `provider === 'claude'`.
  - `new: --parent sets parent and reportsTo the parent's lead`: with `parent: 'dev'` → `parent === 'dev'`, `reportsTo === 'lead'`.
  - `new: refused headless, for an unknown agent, a taken id, a bad id, a missing parent, an empty or multi-line name`:
    `T.Refusal` for `HEADLESS`, `/no agent named ghost/`, `/already exists/` (id `dev`), `T.UsageError` for id `Field`, `/no team nope/` for `parent: 'nope'`,
    `T.UsageError` for `name: '  '` and `name: 'a\nb'`.
  - `the CLI: new prints the team it made; a missing --lead is exit 2`: `main(['new','field','--name','Field','--lead','dev-writer'])` → 0 and stdout matches `/created persona\/teams\/field\//`; without `--lead` → 2.
- [ ] **Step 2: Run** `npm test -w brain/scripts`. Expected: FAIL, `T.newTeam is not a function`.
- [ ] **Step 3: Implement.** `memberIdFor` is addMember's id line, and addMember calls it. `newTeam`: `assertInteractive(env, 'Creating a team')`; `ID_RE` on id; name trimmed, 1–60 chars, no line break; `AGENT_RE` and `agentFiles` on lead (the members test's messages); parent, when given, must be in `listTeams(root)`; refuse an existing folder; read the example template's frontmatter (`parseFrontmatter`) for `gates`, `notify`, `budget`; write `TEAM.md` with `type: team`, `id`, `name`, `lead: <memberIdFor>`, `parent` and `reportsTo` (the parent's `lead`) only when a parent is given, those three keys, `updated: <YYYY-MM-DD>`, and one member built with `addMemberBlock` (`role: Team lead`, `provider` as addMember picks, `model`/`effort` `inherit`, `stage: [all]`, `skills: []`, `voice: ''`, `paused: false`), then the body `\n# <name> team\n`. Under `withLock` on the root, as `initTeam` copies.
- [ ] **Step 4: Run** `npm test -w brain/scripts`. Expected: PASS, the rest of `teams.test.js` included.
- [ ] **Step 5: Edit `plugin/commands/team.md`:** add `new <id> --name <text> --lead <agent>` to `argument-hint`, and one paragraph: run `new` only when the user asks for a team, with the lead they name; it is their decision, so a headless run cannot. Then `npm run build:codex-plugin`.
- [ ] **Step 6: Commit** `lib/teams.js`, `team.js`, `teams.test.js`, `plugin/commands/team.md`, `codex-plugin/` — `feat: aos team new makes a team with the lead you pick`.

### Task 2: the `team-create` surface and its argument builders

**Files:** Modify `app/src/shared/surfaces.ts` (after `teams`, :477), `app/tests/unit/write-policy.test.ts` (:190 table),
`SECURITY.md` (the surfaces table, beside :306), `hud/src/data/teamWriter.ts` (:44), `hud/src/data/teamWriter.test.ts`.

**Interfaces:** Produces `teamIdFrom(name: string): string | null` and
`newTeamArgs(id: string, name: string, lead: string, parent?: string | null): string[]` in `teamWriter.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `teamWriter.test.ts` › `a team id comes from its name, or none`: `teamIdFrom("Field Research") === "field-research"`, `teamIdFrom("  Ops  2 ") === "ops-2"`, `teamIdFrom("Ünïcode Crew") === "nicode-crew"`, `teamIdFrom("123") === null`, `teamIdFrom("🙂") === null`, `teamIdFrom("x".repeat(60))?.length === 41`.
  - same file › `newTeamArgs`: `newTeamArgs("field","Field Research","dev-writer")` deep-equals `["new","field","--name","Field Research","--lead","dev-writer"]`; with `"dev"` adds `"--parent","dev"`.
  - same file › `new through the runner writes a TEAM.md that readTeams parses` (as the other runner tests: temp vault, real `team.js`, an agent file in a temp Claude dir).
  - `write-policy.test.ts`: a `"team-create"` entry: ok `team.js new field --name "Field Research" --lead dev-writer` and with `--parent dev`; no: a name with a line break, a dash-led name, `--lead` before `--name`, `init field` (stays a `teams` rule question), and the surface is not in the verified default.
- [ ] **Step 2: Run** `npm test -w hud` and `(cd app && npm run test:unit)`. Expected: FAIL on the missing exports and surface.
- [ ] **Step 3: Implement.** `teamIdFrom`: NFKD, drop non-ASCII, lowercase, runs of anything outside `[a-z0-9]` → one `-`, trim `-`, drop leading non-letters, cut to 41, trim a trailing `-`, then `ID_RE`-shaped (`/^[a-z][a-z0-9-]{0,40}$/`) or null. Surface: `{ id: "team-create", label: "New agent teams", source: "ui/NewTeamModal.ts (views/AgentWorkspaceTab.ts): + New team, spec 2026-11-12-agent-workspace D14", writes: [], spawns: [argv("new", ID, "--name", NAME, "--lead", ID), argv("new", ID, "--name", NAME, "--lead", ID, "--parent", ID)], verified: false }` with `const NAME = /[^\s-][^\n\r]{0,59}/;`. A SECURITY.md row in the table's style: what it lets the page do, the exact rules, off until a live check per host.
- [ ] **Step 4: Run** both suites. Expected: PASS.
- [ ] **Step 5: Commit** — `feat: a team-create surface for aos team new, off until checked`.

### Task 3: board history and the activity feed

**Files:** Modify `hud/src/data/teams.ts` (`Team` :39-51, `teamFrom` :218-250). Create `hud/src/data/workspace.ts`,
`hud/src/data/workspace.test.ts` (reads `fixtures/teams-vault` as `teams.test.ts` does).

**Interfaces:** Produces `Team.history: BoardItem[]` (every complete board row, file order), and in `workspace.ts`:
`type ActivityKind = "run-start" | "run-end" | "item-new" | "stage" | "gate-open" | "gate-decided" | "budget" | "post"`,
`interface ActivityEvent { ts: string; kind: ActivityKind; member: string | null; item: string | null; text: string; tone: Tone }`,
`activityOf(t: Team): ActivityEvent[]` (newest first, all of them), `const ACTIVITY_PAGE = 50`.

- [ ] **Step 1: Write the failing tests** in `workspace.test.ts`:
  - `history keeps every complete board row and the board is unchanged`: for `lab`, `history.length === parseJsonl(<board.jsonl>).rows.length`, `board` deep-equals what it was (latest per id).
  - `activity: the lab's gate, runs, marker and posts, newest first`: `activityOf(lab)` is sorted by `ts` descending; contains `{ kind: "gate-open", item: "site-01", ts: "2026-09-20T12:00:00.000Z" }`, `{ kind: "run-end", member: "reviewer", item: "site-03" }`, a `run-start` from the `lab-site-02-builder-c` marker, `item-new` for `site-00`, `gate-decided` for `site-02` at `2026-09-20T10:30:00.000Z`; no event names `site-04` (the torn line); no `post` whose source post is `from: "user", kind: "gate"`.
  - `activity over 2,000 generated rows stays sorted and one row can give two events`: a stage move with a user decision yields both `gate-decided` and `stage`.
- [ ] **Step 2: Run** `npm test -w hud`. Expected: FAIL, no `history`, no `workspace.ts`.
- [ ] **Step 3: Implement.** `teamFrom` maps `board.rows` through `itemFrom` into `history`. `activityOf` walks `history` with the previous snapshot per id: none → `item-new`; `stage` changed → `stage`; `status` became `gate` with `gate.state === "pending"` (and the previous was not that pending gate) → `gate-open`; a gate `by: "user"` whose `(name, ts)` differs from the previous → `gate-decided` at `gate.ts`; `budget.usd` changed (previous exists) → `budget`. `runs` rows → `run-end` (status, provider, spend; tone `runTone`); `live` markers → `run-start` at `startedAt`; `channel` posts → `post`, except `from: "user"` with `kind: "gate"`. Text is one plain sentence each (the mockup's lines).
- [ ] **Step 4: Run.** Expected: PASS, and `teams.test.ts` unchanged and green.
- [ ] **Step 5: Commit** — `feat: a team's activity from its board, runs and channel`.

### Task 4: item order and the stage strip

**Files:** `hud/src/data/workspace.ts`, `workspace.test.ts`.

**Interfaces:** `type StripCell = "done" | "current" | "gate" | "blocked" | "todo"`;
`stageStrip(t: Team, it: BoardItem): StripCell[]` (length `t.stages.length`); `itemOrder(t: Team): { open: BoardItem[]; done: BoardItem[] }`.

- [ ] **Step 1: Failing tests:** `items: pending gate, blocked, working, open, paused, then done` on `lab` (first open item `site-01`; `site-00` in `done`); `the strip: done before the stage, the stage's state, todo after` (`site-02` in `execute` of five stages → `["done","done","current","todo","todo"]`; `site-01` gate → `["gate","todo","todo","todo","todo"]`; a done item → all `done`); `ops`' three stages give three cells; an item whose stage the team no longer lists → all `todo`.
- [ ] **Step 2: Run** `npm test -w hud`. FAIL. **Step 3: Implement**; ties keep `t.board` order. **Step 4: Run** it again. PASS.
- [ ] **Step 5: Commit** — `feat: item order and stage strip for the Items list`.

### Task 5: the tree, seats, bench, runs and which node shows

**Files:** `hud/src/data/workspace.ts`, `workspace.test.ts`; move `addable` from `views/teams/ManagePane.ts:135` to `hud/src/data/agents.ts`.

**Interfaces:**
- `type NodeKey = string` — `"needs"`, `"team:<team>"`, `"agent:<agentId>"`, `"member:<team>/<member>"` (a member without an agent).
- `interface TreeRow { key: NodeKey; kind: "needs" | "section" | "team" | "member" | "agent"; label: string; depth: number; tone: Tone | null; lead?: boolean; broken?: boolean; count?: number }`
- `workspaceTree(teams: Team[], agents: AgentsCache, o: { query: string; folded: ReadonlySet<NodeKey> }): TreeRow[]` — Needs you (count, always shown), TEAMS (`orderTeams`, each team then its members, lead first, depth +1 per nesting), BENCH, PLUGINS & CONFIG.TOML (folded by default under key `"section:plugins"`). The query matches team, member and agent names and descriptions, keeping a match's team.
- `interface Seat { team: Team; member: MemberStatus }`; `seatsOf(teams: Team[], agentId: string): Seat[]` (skips teams with `error`).
- `benchOf(agents: AgentsCache, teams: Team[]): AgentRow[]` — `groupAgents(...).yours` with no seat.
- `agentRuns(teams: Team[], agentId: string, now: Date): { runs: (RunRow & { team: string })[]; weekUsd: number }`; `weekUsd(runs: RunRow[], now: Date): number` (last 7 × 24 h).
- `pickNode(o: { saved: NodeKey | null; via: "rail" | "link"; asked: NodeKey | null; gates: number; tree: TreeRow[] }): NodeKey` — asked if in the tree; else `"needs"` when `via === "link"` and gates > 0; else saved if in the tree; else `"needs"` when gates > 0; else the first team, else the first agent, else `"needs"`.

- [ ] **Step 1: Failing tests** (fixture vault plus a hand-built `parseAgents` cache):
  - `tree: needs first, lab then ops under it, members lead first, the broken team marked, bench and folded plugins`.
  - `tree with no agents cache: members by member name, bench empty` (Review focus 2).
  - `tree with a missing parent and a cycle lists each team once` (Review focus 3).
  - `an agent in two teams shows under both and not on the bench` (Review focus 4).
  - `the filter keeps a matching member's team and hides the rest`.
  - `agentRuns sums only the last seven days`.
  - `pickNode` — one assertion per rule above, in order.
- [ ] **Step 2: Run** `npm test -w hud`. FAIL. **Step 3: Implement.** **Step 4: Run** `npm test -w hud && npm run typecheck`. PASS.
- [ ] **Step 5: Commit** — `feat: the Agent Workspace tree, seats and bench`.
- [ ] **Step 6: PR 1.** Verify (§ Verification, the PR 1 lines), push, open the PR with the Hosts table (Claude Code `/team new …` · Codex `$agenticos:team new …`), wait for CI, ask before merging.

---

## PR 2: the tab (`feat: Agent Workspace, one tab for agents and their teams`)

### Task 6: the remembered choice

**Files:** `hud/src/settingsDefaults.ts` (beside `files` :96 and its sanitizer), `hud/src/settingsDefaults.test.ts`.

**Interfaces:** `interface AgentWorkspaceChoice { node: string | null; items: "list" | "board" }`, default
`{ node: null, items: "list" }`, `sanitizeAgentWorkspace(raw: unknown): AgentWorkspaceChoice`.

- [ ] Test `the Agent Workspace choice defaults to no node and the list, and bad parts fall back` (missing key, `items: "grid"`, `node: 42`). `npm test -w hud`: FAIL → implement → PASS → commit `feat: remember the Agent Workspace selection and Items view`.

### Task 7: rail, alias and the tab shell with its tree

**Files:** Modify `WorkbenchView.ts` (`RAIL_SECTIONS` :49-72, `WORKBENCH_TAB_IDS` :81, `open` :584, `setTab` :624,
`makeTab` :604), `hud/main.ts` (:116-121), `pulse/actions.ts` (:46 `openTab`), `PulsePopup.ts` (:179). Create
`AgentWorkspaceTab.ts`, `workspace/Tree.ts`. Tests: `app/tests/e2e/shell.spec.ts`, `harness.ts` (:1025-1030),
`tab-layout.spec.ts`, `app/scripts/smoke-packaged.mjs` (:41), new `agent-workspace.spec.ts`.

**Interfaces:**
- `WorkbenchTarget` and `RevealTarget` gain `node?: string`; `TAB_ALIASES: Record<string, string> = { agents: "agent-teams" }`, applied first in `setTab` and `open`; `WORKBENCH_TAB_IDS` = rail ids + `"agents"` + settings.
- `openTab(ctx: PulseCtx, id: string, node?: string)`; Pulse's per-team **Board →** passes `team:<id>`.
- `AgentWorkspaceTab` implements the tab contract (`mount`, `unmount`, `refresh`, `leave`) and `reveal(t: RevealTarget)`; it owns a `TeamsCtx` per team pane; selection via `select(node: NodeKey)` persisted to `settings.agentWorkspace.node`.
- `renderTree(host: HTMLElement, rows: TreeRow[], o: { selected: NodeKey; onSelect(k: NodeKey): void; onFold(k: NodeKey): void })` in `Tree.ts`, with ↑↓ / → ← / Enter.
- Palette: `open-workbench-agent-teams` → "Open Workbench: Agent Workspace"; `open-workbench-agents` kept → "Open Workbench: Agents (Agent Workspace)".

- [ ] **Step 1: Failing e2e** in `agent-workspace.spec.ts`: `rail: Agent Workspace after Sessions with the bot icon and the gate count; no Agents button`; `tab=agents and tab=agent-teams links open it; a link with a gate pending shows Needs you`; `the tree: Needs you, Example with Survey under it, members lead first, the broken team marked, Bench, Plugins folded`; `the filter narrows the tree and keeps its focus across a redraw`; `the header: counts, sharing state, sync now, + New team`; `a stale agents cache spawns aos agents sync once`. Update `shell.spec.ts` (:69-70, :150, :208-237), `harness.ts` `RAIL_SECTIONS`, `tab-layout.spec.ts`, `smoke-packaged.mjs` `TABS`.
- [ ] **Step 2: Run** `(cd app && node scripts/build.mjs && npx playwright test agent-workspace shell)`. FAIL.
- [ ] **Step 3: Implement.** Header and refresh are `AgentsTab.render`'s and `AgentTeamsTab.refresh`'s (watchers on `AGENTS_PATH` and `TEAMS_DIR`, the 30 s tick and ~45 s sweep while active, torn retries, `setTeamsBadge`). The right pane shows a placeholder per node kind until Tasks 8–12.
- [ ] **Step 4: Run** the same. PASS. **Step 5: Commit** — `feat: Agent Workspace in the rail, with its tree`.

### Task 8: Needs you, the team pane and Activity

**Files:** Create `workspace/NeedsPane.ts`, `TeamPane.ts`, `ActivityPane.ts`; `agent-workspace.spec.ts`.

**Interfaces:** `renderNeeds(host, ctxFor: (t: Team) => TeamsCtx, teams: Team[])` (each card through `renderGateCard`, `showTeam` when more than one team);
`renderTeamPane(host, ctx: TeamsCtx, view: TeamsView, onView: (v: TeamsView) => void)`; `renderActivity(host, ctx, page: number, onMore)`.

- [ ] **Step 1: Failing e2e**, the AT2–AT4 assertions moved here: `NEEDS YOU: each pending gate with item, gate, wait, spend, pitch and presets`; `a preset or − / + changes the Approve amount, writing nothing`; `Approve asks first; Cancel writes nothing`; `Redirect ❯_ opens the lead`; `a team: header line, NOW strip, its gates, Activity first with the fixture's events newest first, older adds more`.
- [ ] **Steps 2–4:** Run `(cd app && node scripts/build.mjs && npx playwright test agent-workspace teams-writes sharing-writes variants)`: FAIL, implement, run again: PASS. **Step 5: Commit** — `feat: Needs you and a team's activity`.

### Task 9: Items, Channel and Settings

**Files:** Create `workspace/ItemsPane.ts`, `SettingsPane.ts`; modify `teams/BoardPane.ts` (export `renderItemDetail(host, ctx, t, it)` from `detail` :148), `teams/InteractPane.ts` (no change beyond imports); `agent-workspace.spec.ts`, `teams-writes.spec.ts`.

**Interfaces:** `renderItems(host, ctx, mode: "list" | "board", onMode)`; `renderSettings(host, ctx)`.

- [ ] **Step 1: Failing e2e:** `items: rows in needs-me order with the stage strip; the toggle shows the board and is remembered after a restart`; `a row opens the item's detail: facts, posts, runs, budget`; `channel: mentions, item filter, Enter posts to the lead, the draft survives a switch` (from AT7); `settings: lead, stages, gates and budget read-only; Pause and Resume; Add a member puts an agent on the team; Open TEAM.md`; `the broken team's pane is the error card with Open TEAM.md` (Review focus 1).
- [ ] **Steps 2–4:** Run `(cd app && node scripts/build.mjs && npx playwright test agent-workspace teams-writes sharing-writes variants)`: FAIL, implement, run again: PASS. **Step 5: Commit** — `feat: Items, Channel and Settings for a team`.

### Task 10: the agent profile

**Files:** Create `workspace/AgentPane.ts`; modify `hud/src/ui/noTextBoxes.test.ts` (`VIEWS` :9); `agent-workspace.spec.ts`, `teams-writes.spec.ts`, `sharing-writes.spec.ts`.

**Interfaces:** `renderAgent(host, o: { agent: AgentRow | null; member: { team: Team; id: string } | null; seats: Seat[]; runs: ReturnType<typeof agentRuns>; ctxFor: (t: Team) => TeamsCtx; hosts: SessionHost[]; teams: Team[]; share(r: AgentRow, on: boolean): void; run(cmd: string, host: SessionHost): void })`.

- [ ] **Step 1: Failing tests:** unit `no text boxes in … AgentPane and SettingsPane`; e2e `a seated agent: hosts, ❯_ per enabled host, copy, open; NOW; one SEAT block per team with pickers; recent runs and the week's spend`; `an effort pick rewrites its TEAM.md line and back` (from AT8); `pause seat`; `Remove from <team> asks first; the lead's refusal is shown` (Review focus 4); `Seat in… lists only teams it is not on and adds it`; `a bench agent; a plugin agent shows no SEAT or sharing; a member without an agent shows its seat and "no agent"`; `unshare / share` (from AG4).
- [ ] **Steps 2–4:** Run `(cd app && node scripts/build.mjs && npx playwright test agent-workspace teams-writes sharing-writes variants)`: FAIL, implement, run again: PASS. **Step 5: Commit** — `feat: an agent's profile in Agent Workspace`.

### Task 11: + New team and the empty states

**Files:** Create `hud/src/ui/NewTeamModal.ts`; `AgentWorkspaceTab.ts`; `agent-workspace.spec.ts`, `variants.spec.ts` (:77, :841), a `team-create` test in `teams-writes.spec.ts` with `AOS_APP_WRITE: "teams,team-create"`.

**Interfaces:** `new NewTeamModal(app, { agents: AgentRow[]; teams: Team[]; onCreate(args: string[]): Promise<boolean> })` — a name field, the id from `teamIdFrom` shown under it (Create disabled and the reason shown when null or taken), a lead picker of `addable` agents, an optional parent picker; Create runs `newTeamArgs` through the tab's `act`.

- [ ] **Step 1: Failing e2e:** `+ New team: the id follows the name; an emoji-only name or a taken id disables Create with the reason; Create writes TEAM.md with the lead and selects the new team`; `with team-create off, Create is refused and the dialog says why`; `no teams: Bench lists every agent, the pane offers Seed the example team and + New team` (from AT1/variants); `Codex-only: ❯_ codex only, Redirect runs codex` (AT10, `variants.spec.ts` :258, :653).
- [ ] **Steps 2–4:** Run `(cd app && node scripts/build.mjs && npx playwright test agent-workspace teams-writes sharing-writes variants)`: FAIL, implement, run again: PASS. **Step 5: Commit** — `feat: + New team in Agent Workspace`.

### Task 12: retire the old tabs, tour, docs rows

**Files:** Remove `AgentsTab.ts`, `AgentTeamsTab.ts`, `teams/RosterPane.ts`, `teams/ManagePane.ts`, `VIEWS` in `teams/ui.ts`, the old specs `agent-teams.spec.ts` and the Agents tests in `skills-agents.spec.ts`. Modify `hud/styles.css`, `surfaces.ts` (`teams` and agents `source` strings), `steps.json` (:184-203), `steps.ts` (:66), `whatsnew.json`, `COVERAGE.md`, `docs/app-smoke.md`, `CHANGELOG.md`.

- [ ] **Step 1:** the `agent-workspace` chapter on tab `agent-teams`, steps `tree`, `needs`, `activity`, `items` (with the toggle), `agent`, `sync`, each `since: "2.8.0"`, anchors on `data-tour` attributes the panes set; `TOUR_TABS` without `agents`; a 2.8.0 `whatsnew` entry (`id: "agent-workspace"`, steps those ids).
- [ ] **Step 2:** `[Unreleased]`: Changed — the two tabs are one, Agent Workspace (`<!-- tour: agent-workspace.tree -->`); Added — Activity, the Items list, agent profiles, + New team, `aos team new` (`<!-- no-tour: a CLI verb -->` for the last). AW1–AW*n* rows in `COVERAGE.md` replace AT1–AT11 and AG1–AG8 (AG5–AG7 stay N/A); one `## Agent Workspace (both hosts)` section in `app-smoke.md`.
- [ ] **Step 3: Run** `npm test -w hud && npm run typecheck`, `node tools/changelog.js check current`, `cd app && npm run typecheck && npm run test:unit && npm run check:compat && npm run test:e2e`. All green; `rg -n "AgentsTab|AgentTeamsTab|RosterPane|ManagePane" hud app/src` finds nothing.
- [ ] **Step 4: Commit** — `chore: retire the Agents and Agent Teams tabs`; then PR 2 (§ Verification), CI, ask before merging.

---

## PR 3: docs (`docs: Agent Workspace in the README, commands and template`)

### Task 13: text and screenshot

- [ ] README: the Agent teams card and the app paragraph (:75, :112, :135-136) name Agent Workspace; `cd app && npm run screens` writes `docs/assets/screens/agent-workspace.png` (rename `readme.screens.ts`'s `agent-teams` shot) and the old image is removed.
- [ ] `plugin/commands/agents.md:18` and `team.md:2,8` say "the Workbench Agent Workspace tab"; `vault-template/persona/teams/example/TEAM.md:52,58` likewise; `npm run build:codex-plugin`; `npm test` (`cli/vault-template.test.js`).
- [ ] Commit, PR, CI, ask before merging.

### Task 14: the live check that turns `team-create` on (before the 2.8.0 release)

- [ ] On this machine, in the dev app (`cd app && npm start`) with `AOS_APP_WRITE=teams,team-create`: create a team with a Claude Code agent as lead, then one with a Codex-only agent; each `TEAM.md` parses (`aos team list`), the tree selects it. Record the run in `docs/acceptance.md`.
- [ ] Set `verified: true` on `team-create`, update its SECURITY.md row ("On by default since its live check on <date>"), and the write-policy test's default-surfaces assertion. Commit — `chore: team-create on after its live check`.

## Verification (before each PR)

```sh
npm run gate -- --require-private
npm run build:codex-plugin && git status --short codex-plugin     # nothing left after the build
npm test && npm run lint && npm run lint:sh && npm run typecheck
node tools/changelog.js check current
node ~/.claude/skills/AgenticOS-New-Feature/scripts/parity-check.js --wip --rehearse   # PR 1 (plugin and runtime change)
(cd app && npm run typecheck && npm run test:unit && npm run check:compat && npm run test:e2e)   # PR 2 and Task 2
node ~/.claude/skills/AgenticOS-New-Feature/scripts/publish-check.js
```
