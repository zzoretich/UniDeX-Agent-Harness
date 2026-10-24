# UniDeX Connectors: every MCP server and connector, on both hosts — design

**Date:** 2026-10-23
**Status:** approved 2026-10-23, on `feat/connectors-data`. *(user)* rows are the user's interview answers; the rest are approved technical decisions (D4 included). Mockups are private (a Design canvas). A1 and A3 answered (§6); A2 is a build check in PR 3.
**Base:** `main` at `38b4c97` (2.1.1 plus #170). Runtime (`brain/scripts`, `cli`), the HUD, the app's surface rules; no `plugin/` change, so `codex-plugin/` is untouched.
**Scope:** a new rail tab, **Connectors** (id `connectors`, icon `plug`), that finds every MCP server and connector both hosts can use, says which work, what tools they give and how much they are used, and later turns them on and off. Code comments cite `connectors-tab D<n>`.

---

## 1. Problem

At 38b4c97, on a real vault (Claude Code 2.1.310, codex-cli 0.162.1):

1. **The only list is thin.** Skills ▸ MCP SERVERS (`hud/src/views/SkillsTab.ts:82-240`) reads `brain/_index/mcp-servers.json`, which holds user-scope servers only: no plugin servers, no project scope (`lib/import/mcp.js:13-14`), no connectors. On this Mac it has 8 rows; the hosts report 16 for Claude Code (9 claude.ai connectors) and 8 for Codex, plus ChatGPT-app connectors from Codex plugins (`.app.json`).
2. **Nothing refreshes it.** Only `aos import --only mcp` and `aos mcp copy` (`cli/mcp.js:592-597`) write it; it is in neither `BACKGROUND` (`app/src/shared/surfaces.ts:99-105`) nor `scan-vault.js`. Here it was last written 2026-10-16.
3. **No status.** Three servers fail today (Ticketmaster `-32600`, Uber Eats `429`, `codex` `CONNECTION_CLOSED`) and nothing in the Workbench says so; `aos doctor` checks only the vault's own server (`cli/aos.js:446-475`).
4. **No tools, no usage.** Nobody can see what a server gives the agents, or that 14 of 25 had no call in 30 days (a probe over 946 transcripts took 4 s; `lib/transcript.js:65,147` already names MCP calls `mcp__<server>__<tool>` for both hosts). Built-in servers (`claude-in-chrome`, `ccd_*`) appear only in transcripts.
5. **Copy is the only action**, and it refuses a remote server for Codex (`cli/mcp.js:368`) though `codex mcp add --url` exists in 0.162.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | *(user)* **Found automatically, by default**: nothing to register; every source below is read on every refresh. | Manual import. An opt-in. |
| D2 | *(user)* **A new tab after Skills** in the rail's third section; Skills' MCP SERVERS section moves here and Skills keeps one line linking to it. | Both places. The top section. |
| D3 | *(user)* **Layout C, health board:** summary tiles (need attention · connected · unused 30 days · off), NEEDS ATTENTION cards with one fix each, then CONNECTORS and MCP SERVERS cards (host dots, tools, calls, a 30-day sparkline), then folded BUILT IN, OFF and PROJECT rows. | A three panes. B host matrix. |
| D4 | **A card opens a detail sheet** (480 px, from the right, over the board): one row per host (status, scope, file, Park/Remove), usage (calls, by host, per day), tools (chips with call counts). A's dossier, kept. | A full-page dossier. Inline expansion. |
| D5 | *(user)* **Rail badge:** a danger-toned count of what needs attention after the last check; hidden at 0 and when the last check is over 24 h old. | No badge. A notification per failure. |
| D6 | *(user)* **Three PRs:** 1 data (discovery, live check, usage, `aos mcp list/check`); 2 the read-only tab, Skills' section moved; 3 the actions. | One or two PRs. |
| D7 | **Sources, per host** (§4.1): Claude Code user and local scope (`.claude.json`), project `.mcp.json` with its approvals, enabled plugins' `.mcp.json`, claude.ai connectors (from the check); Codex `config.toml` in every form `codexServerMap` reads, project config of trusted projects, enabled plugins' `.mcp.json` and `.app.json`. | `codex mcp list` in discovery (a spawn per refresh). |
| D8 | **Discovery reads files only**: no spawn, no network, no model call, so it can run inside `scan-vault.js` on every refresh. The check (D10) is what spawns. | Discovery in the HUD. Its own timer. |
| D9 | **One row per host per name, merged by the HUD** (as `mcpItems` does): servers by name, connectors by display name (a `claude.ai <Name>` connector and a Codex app whose display name is `<Name>` are one card with two dots). | Merging in the runtime. |
| D10 | *(user)* **Live check when the tab opens, every 15 min while it stays open, and on Check now** (`aos mcp check --json`, single-flight under a lock). Claude Code: `claude mcp list`, parsed by its leading glyph (✔ ✘ ! ⏸), unknown labels kept as written. Both hosts: the runtime's own MCP client (`@modelcontextprotocol/sdk`, already a dependency) runs `initialize` + `tools/list` on each server the host would start, at most 4 at a time, 10 s each; one handshake per identical config. Codex: `codex mcp list --json` supplies `enabled` and `auth_status`. | A background check with the tab closed (spawns every server hourly). Check now only. |
| D11 | **The check starts only what the host would start**: never a project server the host shows pending approval, never one in an untrusted Codex project, never one that is off. The full entry (env, headers) is read at check time and kept in memory only. | Starting everything listed. |
| D12 | *(user)* **Tools for connectors are "seen in use"**, from usage, labelled "may be partial"; servers the check reaches list every tool. | A headless model call. Nothing. |
| D13 | *(user)* **Usage from both hosts' transcripts**, through `lib/transcript.js`, incremental by file (mtime + size) like `session-index.json`, over `connectors.usageDays` (30): per host and name, calls, sessions, last used, calls per day, calls per tool. A name no source declares becomes a **built-in** row. | The HUD reading transcripts. Counting in the check. |
| D14 | **Three caches** (§4.2), each with its own writer and cadence: `connectors.json` (discovery), `connectors-live.json` (the check), `connectors-usage.json` (usage). `mcp-servers.json` keeps its schema-1 rows, made from the same discovery, so an older app's Skills section still works; it is retired a release later. | Bumping `mcp-servers.json` to schema 2. One cache. |
| D15 | **CLI verbs under `aos mcp`** (`list`, `check`, then PR 3's `park`, `unpark`, `add`, `remove`, `login`), each with `--json`, so a terminal on either host does what the page does. | A new `aos connectors` family. |
| D16 | *(user)* **Disable means park**: the server is removed through the host's CLI after its exact entry is saved 0600 in `~/.local/share/unidex/parked/mcp/` (the backup folder's `ownDir` rules; denied to the page by name); Turn on re-adds it unchanged. | Codex's TOML flag only. Per-workspace disable. |
| D17 | **Plugin and account rows don't park.** A Claude plugin's server: "Turn off plugin X" (`claude plugin disable`), which also turns off its skills, said in the confirm. A Codex plugin's: no CLI verb exists, so the sheet names Codex's plugin settings. A connector: a link to claude.ai's or ChatGPT's connector settings. The vault's own `agenticos`: never. | Editing `config.toml` by hand. Hiding them. |
| D18 | *(user)* **Add takes names, never values**: a secret is `NAME ← $VAR`; Claude Code gets `${VAR}` in `add-json`, a remote Codex server `--bearer-token-env-var`. Every write is a dry run, a hash, and the run with `--expect` (as `aos mcp copy`), with the host's config backed up first. | Values in the form. A terminal paste. |
| D19 | *(user)* **Sign in:** Codex runs `codex mcp login <name>` (the browser finishes it; 5 min cap); Claude Code has no CLI login, so a local server opens a Code terminal running `claude` to type `/mcp`, and a claude.ai connector links to claude.ai. | Claude-only sign-in. |
| D20 | **Copy goes on**, moved into the sheet ("Copy to Codex"), and now copies a remote server to Codex with `codex mcp add --url`. | Leaving the refusal. |
| D21 | **Surfaces:** PR 1 adds `mcp list --json` and `mcp check --json` to `BACKGROUND` (runtime-owned caches only, under locks); PR 3 adds argv rules to the existing `mcp` surface, which stays off for the new verbs (`verified: false`) until a live check per host. | A new surface. |
| D22 | **Config `connectors.*`:** `checkEveryMin` 15, `usageDays` 30, `probeTimeoutSec` 10, `probeConcurrency` 4. | Hard-coded. |
| D23 | **Feel:** `--udx-*` tokens, both themes, colour only for state; Claude Code info blue, Codex gate violet (as Spaces); `.aos-con-*` classes. | New colours. |

## 3. What already exists (verified at 38b4c97)

- `lib/import/mcp.js`: `listServers(host)` (:250), `writeServers` (:255, atomic, per host), `claudeUserFile` (:36), `codexServerMap` (:177, every TOML form), `cleanUrl` / `secretName` / `TOKEN_SHAPE` (secret hiding). Called by `cli/import.js` → `lib/import/index.js:159-166`, `cli/hosts.js:35,106`, `cli/mcp.js:593`.
- `cli/mcp.js` copy: `targetCommand` (:344) writes only through `claude mcp add-json --scope user` / `codex mcp add`; `planHash` HMAC (:410) under `~/.local/share/unidex/keys/mcp-plan.key`; backups `~/.local/share/unidex/backups/mcp` (:476, `ownDir` :420, newest 10); lock `fsx.withLockSync` (:580). Values reach the CLI's argv (SECURITY.md, the `mcp` row).
- `cli/aos.js` `mcpProbe` (:337): a stdio `initialize` probe with a 20 s timeout; `claudeBin` (:215), `codexBin` (`cli/codex-host.js:68`).
- `lib/skills.js`: `claudePlugins` (:95, `installed_plugins.json` + `enabledPlugins`), `codexEnabledPlugins` (:109), `codexPluginRoot` (:123, but only roots with `skills/`, so a variant is needed).
- `lib/transcript.js`: MCP calls as `mcp__<server>__<tool>`, Claude `tool_use` (:103) and Codex `mcp_tool_call_end` (:147).
- HUD: `data/mcpServers.ts` (`mcpItems`, copy offers), `SkillsTab.ts:82-240`, tour step `skills.mcp` (`steps.json:203`), smoke `docs/app-smoke.md:262-263`, coverage SK10–SK12 (`COVERAGE.md:362-364`), fixture `MCP_FIXTURE` (`make-fixture-vault.mjs:690`). Rail badges `setBadge` / `refreshBadges` (`WorkbenchView.ts:298,311`); tab timers gate on `isTabActive` (`AgentTeamsTab.ts:73`).
- The page reads no host config (`app/src/main/policy/read-scope.ts:121-135`); `brain/_index/**` is runtime-only (`surfaces.ts:266`).

## 4. Design

### 4.1 Discovery (PR 1, `lib/connectors/discover.js`)
Per enabled host (`host.js` `enabledHosts`, `hostDirs`): read each source of D7 and emit rows `{host, name, kind: server|connector, transport, command|url (cleaned as today), source: {type: user|local|project|plugin|account, file, plugin?, workspace?}, enabled, approval?: approved|pending}`. Project sources: each `workspaces/*` folder (and its `repo:` alias) with a `.mcp.json`; Claude local scope from `.claude.json` `projects[<path>]` for those folders; Codex `<repo>/.codex/config.toml` only when `config.toml` trusts that project. claude.ai connectors are not in any file: the last check's list is carried into discovery, and before any check `claudeAiMcpEverConnected` supplies names marked `unverified`. Codex connectors: each enabled plugin's `.app.json` `apps`, named by its `plugin.json` `interface.displayName`.

### 4.2 Caches (all `brain/_index/`, `fsx.writeAtomic`, schema 1)
- `connectors.json` `{schema, updatedAt, hosts: {claude|codex: {enabled, sources: n, error?}}, rows: [...]}`. Written by `scan-vault.js` and `aos mcp list`; also re-derives `mcp-servers.json` (D14).
- `connectors-live.json` `{schema, checkedAt, durationMs, hosts: {h: {ran, error?}}, rows: [{host, name, status: connected|failed|needs-auth|pending|off|unknown, detail, tools: [{name, summary}], toolsAt}]}`; `detail` and summaries are capped (200 chars) and pass `scrub`.
- `connectors-usage.json` `{schema, updatedAt, days, cursor: {<file>: [mtimeMs, size]}, rows: [{host, name, calls, sessions, lastUsed, perDay: [..], perTool: {..}}]}`, where `name` maps from the call's server key: `plugin_<p>_<s>` → that plugin server, `claude_ai_<Name>` → that connector, else the name itself.

### 4.3 The tab (PR 2, `views/ConnectorsTab.ts`, `data/connectorsModel.ts`)
The board and sheet of D3/D4 from the three caches, merged by D9; host columns and dots only for enabled hosts (`sessionHosts`). Mount: render the caches, then `aos mcp check --json` if the last check is older than `checkEveryMin`; a timer gated on `isTabActive("connectors")`; Check now. States: never checked ("Checking…" with config rows as `not checked`), a host CLI missing (a banner naming it; that host's rows from config only), empty (no servers: a line and Add server in PR 3). The badge reads `connectors-live.json` (`touchesBadges` gains it). Skills keeps "MCP servers moved to Connectors →". Tour: `connectors` chapter; `skills.mcp` retargets.

### 4.4 Actions (PR 3)
Park / Turn on, Remove, Add, Sign in, Copy, each a dry run → hash → `--expect` run, backups first, writes only through the hosts' CLIs (`claude mcp add-json|remove --scope`, `claude plugin disable`, `codex mcp add|remove|login`), then `aos mcp list` and a check of the one server.

## 5. Host parity

1. **Entry:** the Connectors tab, and `aos mcp list|check` (later `park|unpark|add|remove|login`) in any terminal; no slash command or skill, so `plugin/` and `codex-plugin/` don't change. 2. **Hooks:** none. 3. **Model calls:** none (no provider, no spend). 4. **Session data:** usage reads both formats through `transcript.js` and `hostDirs`; the HUD reads only caches. 5. **MCP:** no new tool. 6. **Degradation:** below. 7. **Docs:** README "Everyday commands" (`aos mcp`), `docs/app-smoke.md` items per host, COVERAGE rows, SECURITY.md rows for the new rules.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Connectors tab; `aos mcp list` / `check` | Claude sources; `claude mcp list` + handshakes; Claude transcripts | No Codex dots or column. `claude` missing: banner, config rows "not checked", no claude.ai connectors |
| Codex only (plugin · direct) | the same (direct wiring changes nothing: the agenticos server is skipped either way) | Codex sources incl. plugins' apps; `codex mcp list --json` + handshakes; Codex rollouts | No claude.ai connectors (they are Claude's); ChatGPT apps show "via ChatGPT sign-in"; `codex` missing: banner, config rows only |
| Both | the same | both, merged by name | — |

Host differences (D-rows): Claude's status comes from `claude mcp list`, Codex's from the handshake (D10); claude.ai connectors are found only by the check (§4.1); sign-in differs (D19); a Codex plugin server can't be parked (D17).

## 6. Decided 2026-10-23, and one build check

- **A1** *(user)* Codex stdio secrets: `codex mcp add` takes `--env K=V` values only and `env_vars = ["NAME"]` exists only in TOML, so the add runs without the secret and the confirm shows the one `env_vars` line to paste (with Copy). Host config still changes only through the host's CLI. Rejected: a surgical TOML write; values for Codex only.
- **A2** Build check (PR 3): Claude Code expands `${VAR}` in a user-scope `add-json` entry as it does in `.mcp.json`. If not, Claude Code gets A1's answer too.
- **A3** *(user)* Usage lives in Connectors only. Rejected: a Pulse line.

## 7. Out of scope
Installing servers from a marketplace or registry; editing a server's arguments in place; an MCP tool that lists connectors to agents; Claude Desktop's config; per-tool allow/deny lists; Notifications for failures (D5); cost per server.
