# UniDeX Agent Workspace: one tab for agents and the teams they sit in — design

**Date:** 2026-11-12
**Status:** approved 2026-11-24, on `feat/agent-workspace`. *(user)* rows are the user's interview answers (mockups in the
private brainstorm folder, `.superpowers/`, gitignored); the rest are technical calls, and *(builder's call)* marks the
ones settled after the builder check. Code comments cite `agent-workspace D<n>`.
**Base:** `main` at `286da6c0` (2.7.0). The HUD, the app's surface rules and tests, one runtime verb, and plugin
text (so `codex-plugin/` is rebuilt).
**Scope:** the **Agents** and **Agent Teams** rail tabs become one tab, **Agent Workspace**: an org tree of teams and
agents on the left, the selected team, agent or "Needs you" on the right. Nothing underneath changes: same files, same
`aos team` and `aos agents` writes, same in-session `/team` and `/agents`.

---

## 1. Problem

1. **Two tabs, one subject.** Both read `brain/_index/agents.json` (`AgentTeamsTab.ts:8` imports `readAgents`), but
   neither shows the other's half: Agents never says which team seats an agent; Agent Teams' Roster and Manage repeat
   agent facts (provider, model, run links) that Agents already shows, and Manage's "Add a member" is the only place
   that links the two.
2. **The rail is long** (16 buttons) and the two buttons sit apart in its third section.
3. **The team view leads with columns.** The Board (`teams/BoardPane.ts:97`) answers "where is each item", not "who is
   doing what" or "what happened while I was away", and at the pane's real width its five columns wrap.
4. **Teams nest** (the real vault: Staff, with Dev under it via `parent`), but chips (`AgentTeamsTab.ts:261`) show it
   only by indent, and agents outside every team are invisible from Agent Teams.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | *(user)* **One roster, two uses:** an agent is a person, a team is where it sits. One tab replaces both. | Tidying both tabs. Work-first with agents behind the team. |
| D2 | *(user)* **Name and place:** label "Agent Workspace", icon `bot` (Agents' icon), in the rail's first section right after Sessions (`chat`). The rail badge (pending gates, `WorkbenchView.ts:462`) moves with it. | Third section after Brain. The `users` icon. |
| D3 | **The tab id stays `agent-teams`** (as Brain kept `memory`, brain-hub D16); `agents` becomes an **alias** resolved inside `setTab` and `open`, and added to `WORKBENCH_TAB_IDS` explicitly (it is built from the rail, :81). So statusline OSC 8 links from older vendored runtimes (`statusline-render.js:189-202`), Pulse (`pulse/actions.ts:90`, `PulsePopup.ts:179,211`, `pulse/meta.ts:17`), Settings' "Manage in Agents" (`SettingsTab.ts:381-383`) and both palette command ids keep working. | A new id: every link and every installed runtime's statusline would need it. |
| D4 | *(user)* **Layout B, org tree.** Left: a filter box; **Needs you · N**; **TEAMS** nested by `parent` (`orderTeams`), each team's members under it, lead first, a status dot each (blue working, red blocked, violet a team with a pending gate, dim paused); **BENCH**, your agents seated in no team; **PLUGINS & CONFIG.TOML**, listed only, folded. An agent seated in two teams appears under each. Right: the selected node. | A Directory of cards. Team tabs with a member strip. |
| D5 | *(user)* **Needs you is a node.** Its pane is today's NEEDS YOU strip, every pending gate card across teams (`renderGateCard`, unchanged: presets, − / +, Approve asks first, Redirect ❯_). **Which node shows** *(builder's call)*: `setTab` (a rail click, Settings' "Manage in Agents") shows the saved selection, and the first time Needs you when a gate is pending, else the first team, else Bench. A link through `open()` (statusline, Pulse) with no node shows Needs you when a gate is pending, else the saved selection; a reveal target may name a team or an agent (Pulse's per-team **Board →** names its team). | Gates only inside each team. |
| D6 | *(user)* **Team pane:** a header line (lead, members, open items, spend this week), a **NOW** strip of members working or blocked (idle ones counted), this team's gate cards, then **Activity · Items · Channel · Settings**, Activity by default. | Board first. |
| D7 | *(user)* **Activity** is one newest-first feed built from the team's own files: finished runs (`runs.jsonl`), live runs (`running/` markers), board history (an item added, its stage moved, a gate opened, a gate approved or redirected `by: user`, a budget changed), and channel posts. Derived by a pure function in `data/`; no model call. 50 events, then "older" adds 50. | A board. A model-written summary. |
| D8 | *(user)* **Items** is a flat list: id, title, a stage strip (one segment per `team.stages`, done green, current blue, gate violet, blocked red), who holds it now, budget. Sorted pending gate → blocked → working → open → paused; done folded last. A **list · board** toggle brings back today's `renderBoard`; the choice is remembered. A row or card opens today's item detail below. | Board only. A list grouped by stage. |
| D9 | **Channel** is today's Interact pane, moved unchanged (message box, mentions, item filter, Talk to, kept drafts). | A redesign now. |
| D10 | **Settings** shows lead, reports-to, parent, stages, gates and the default budget read-only, with **Pause / Resume** (`aos team pause|resume`), **Add a member** (a picker of your addable agents not on this team, `member add`, as Manage had; *builder's call*) and **Open TEAM.md**. `aos team set` takes only `provider|model|effort` (`lib/teams.js:31`), so editing the rest is out of scope. | New `set` keys in this feature. |
| D11 | *(user)* **Agent pane, a profile.** Header: name, host pills, description, ❯_ per enabled host, ⧉ copy, open file. **NOW:** a live run of any of its seats. **SEAT:** one block per team seat: team, role, stages, provider / model / effort pickers (`aos team set`), pause seat (`pause <team> <member>`), **Remove from <team>** (`member remove`, confirm first; the runtime refuses the lead and a member that owns open items, and the pane shows its message); with no seat left the agent shows under BENCH. Any agent `addable()` admits gets **Seat in…**, a picker of the teams it is not on (`member add`), so an agent can sit in two teams as today *(builder's call)*. **HOSTS:** each host's file, original or translated copy, how to reach it, read-only, the share chip and share / unshare (`aos agents include|exclude`). **RECENT RUNS:** its seats' `runs.jsonl` rows across teams, spend this week, a link to Runs. A plugin agent: header and HOSTS only. | Keeping Roster and Manage. |
| D12 | **A member whose agent is missing** (`agent: null`, or a name not in `agents.json`) shows in the tree by member name with a dim "no agent"; its pane is the SEAT block with that note. | Hiding it. |
| D13 | **Header:** "Agent Workspace", counts (agents · teams · running · gates), the sharing state and its age, **sync now** (and the stale-cache sync on open, `agentsStale`), **+ New team** (D14), and the Codex-subagents-off warning when it applies. | Two headers. |
| D14 | *(user, A1)* **+ New team**: a dialog with a team name (the id is derived from it: lowercase, spaces to hyphens, checked against `ID_RE` and shown under the field) and a lead picked from your addable agents (and an optional parent), running a new runtime verb `aos team new <id> --name <text> --lead <agent> [--parent <team>]`: a `TEAM.md` with that `name:`, the lead as its only member and the default stages and gates, refused under `AOS_HEADLESS=1` (agent-teams D4). Its argv rule goes on a **surface of its own**, `team-create` (as `mcp-manage`, connectors-tab D21: `verified` is per surface, so a rule on `teams` would turn every team write off), `verified: false` until a live check per host, run before the release so it ships on *(builder's call)*. | `aos team init <id>`: a copy of the example team whose placeholder members point at agents the user may not have. |
| D15 | *(user)* **Empty states.** No teams: TEAMS reads "No teams yet" with **Seed the example team** and **+ New team**; BENCH lists every agent of yours; the right pane keeps today's empty text. No agents either: today's Agents empty line. Your agents never vanish because no team exists. | Hiding the tree. |
| D16 | **Refresh** is the union of both tabs' today: watchers on `agents.json` and `persona/teams/`, the 30 s tick and ~45 s `aos team list --json` sweep while showing, torn-tail retries, filter focus and channel draft kept across redraws. | New timers. |
| D17 | **Files:** a new `views/AgentWorkspaceTab.ts` and `views/workspace/*` panes; `teams/BoardPane.ts`, `InteractPane.ts` and `ui.ts` are reused; `AgentsTab.ts`, `AgentTeamsTab.ts`, `RosterPane.ts` and `ManagePane.ts` retire. The agent and settings panes join `noTextBoxes.test.ts` in Manage's place. Classes `.aos-aw-*` (`.aos-ws-*` is Spaces'). | Growing `AgentTeamsTab.ts`. |
| D18 | **Tour:** the `agent-teams` and `agents` chapters (`steps.json:184-203`) become one `agent-workspace` chapter on tab `agent-teams` (tree, Needs you, Activity, Items and its toggle, an agent's profile, sync now), `since` the next version; `TOUR_TABS` drops `agents`; a `whatsnew.json` entry for that release. | Keeping two chapters. |
| D19 | **Three PRs.** 1: data and runtime (`activityOf`, item order, the agent-to-seats index, board history kept, `aos team new` with its surface rule, tests). 2: the tab (tree, panes, rail move, alias, old tabs retired, tour, e2e, smoke and coverage rows, CHANGELOG). 3: docs (README card and screenshot, plugin and vault-template text, `codex-plugin/` rebuilt). | One PR. |

## 3. What already exists (verified at 286da6c0)

- **Rail and routing:** `RAIL_SECTIONS` (`WorkbenchView.ts:49-72`; `agent-teams` `users` and `agents` `bot` at :66-67);
  `WORKBENCH_TAB_IDS` from the rail (:81); `open()` (:584) refuses an unknown id; tabs built at :616-617; palette
  commands per id (`hud/main.ts:116-121`). Rail order is pinned by `shell.spec.ts:69-70,150,208-237`, `harness.ts:1025-1030`,
  `tab-layout.spec.ts`, `smoke-packaged.mjs:41`.
- **Team data:** `data/teams.ts`: `Team` carries `board`, `channel`, `runs`, `live`, `parent` (:39-51); `teamFrom` (:218)
  folds the board to the latest row per id (:238, `latestRows` :148) but parses every row, so history is at hand;
  `memberStatus` (:252), `orderTeams` (:275), `boardColumns` (:303), `gateCards` (:396), `channelView` (:407).
- **Agent data:** `data/agents.ts`: `AgentRow` (:17), `groupAgents` / `filterAgents` / `statusChip` / `runCommand` /
  `asOf` (:99-151); `addable()` (`teams/ManagePane.ts:135`).
- **Writes:** `data/teamWriter.ts` (:28-51: list, init, approve, budget, pause, set, member add/remove, post), admitted
  by the `teams` surface (`surfaces.ts:463-477`, where `init` takes no id); agents share/unshare (`surfaces.ts:381`);
  background `agents sync` and `team list` (:153,157). `aos team` usage (`team.js:15-30`); `initTeam` (`lib/teams.js:478`);
  `removeMember` refuses the lead and an owner of open items (:467-474).
- **Tests and docs:** e2e `agent-teams.spec.ts`, `teams-writes.spec.ts`, `skills-agents.spec.ts`,
  `sharing-writes.spec.ts`, `variants.spec.ts`; `COVERAGE.md` AT1-AT11, AG1-AG8; `docs/app-smoke.md` §"Agent Teams tab"
  and §"Agents"; README card and `docs/assets/screens/agent-teams.png`; `plugin/commands/agents.md:18` and
  `team.md:2,8` name the old tabs; `vault-template/persona/teams/example/TEAM.md:52,58` too.

## 4. Design

### 4.1 Data (PR 1)
- `teamFrom` also keeps `history: BoardItem[]` (every parsed board row, in file order). `activityOf(team, now)` returns
  `{ ts, kind, member, item, text, tone }[]` newest first: `run-start` (marker), `run-end` (runs row: status, provider,
  spend), `item-new`, `stage`, `gate-open`, `gate-decided` (`by: user`), `budget`, `post`. Pure, unit-tested on the
  shared fixture vault.
- `itemOrder(team)` gives D8's sort; `stageStrip(team, item)` the segment states.
- `seatsOf(teams, agentId)` maps an agent to `{ team, member }[]`; the bench is "yours" minus every seated agent.
- **`aos team new <id> --name <text> --lead <agent> [--parent <team>]`** (D14): validates the id (`ID_RE`), the agent
  (as `member add` does), refuses an existing folder and `AOS_HEADLESS=1`, writes `TEAM.md` from the example template's
  team-level keys with the lead as the only member. Its argv rule sits on the new `team-create` surface (D14).

### 4.2 The tab (PR 2)
Tree and panes as D4-D13. Keyboard: ↑↓ walk the tree, → / ← open and fold a team, Enter selects; the right pane's tabs
keep today's arrow-key handling (`tabKeys`). Selection and the Items toggle persist with the HUD's saved UI state.
Gates: every action is today's code path (`renderGateCard`, Approve's confirm and the lead's next step, Redirect).

## 5. Host parity

1. **Entry:** the rail button, "Open Workbench: Agent Workspace" (both command ids kept), links with `tab=agent-teams`
   or `tab=agents`. Same on both hosts. In session, `/team` and `/agents` (Claude Code), `$agenticos:team` and
   `$agenticos:agents` (Codex plugin), `$team` / `$agents` (direct) are unchanged; only their text names the new tab.
2. **Hooks:** none. 3. **Model calls:** none; Activity is derived. 4. **Session data:** none; the HUD reads
   `agents.json` and `persona/teams/` as today. 5. **MCP:** none.
6. **Degradation:** a disabled host's pill is struck and its ❯_ button absent (today's rule, `sessionHosts`); Codex
   subagents off shows the header warning; sharing off shows its reason. Seat pickers offer only the presets
   `aos team list --json` names.
7. **Docs:** README card and screenshot; `docs/app-smoke.md` §"Agent Workspace (both hosts)" replacing the two
   sections; COVERAGE AT/AG rows re-pointed; plugin text, then `npm run build:codex-plugin`.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | rail, palette, links; `/team`, `/agents` | the HUD; writes via `aos team` / `aos agents`; ❯_ `claude --agent` | codex pills struck; no ❯_ codex |
| Codex only (plugin · direct) | rail, palette, links; `$agenticos:team` · `$team` | the same; ❯_ and the lead's sessions on `codex` (`variants.spec.ts`) | claude pills struck; Codex-subagents-off warning when it applies |
| Both | all of the above | the same; sharing mirrors each host's agents | — |

## 6. Out of scope

Editing lead, stages, gates or the default budget (needs new `set` keys); a Channel redesign; dispatching from the
tab (agent-teams D10 stands); agents outside your machine; deleting a team.

## 7. Open questions

- **A1** (D14), answered 2026-11-24: **+ New team** creates an empty team with a lead the user picks, through a new
  `aos team new` verb, not a copy of the example team.

None open.
