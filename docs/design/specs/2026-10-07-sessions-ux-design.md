# UniDeX Sessions: host and model menus, a Claude Code-style tab

**Date:** 2026-10-07
**Status:** draft for approval. The mockups (options A–C, three pickers, the composer details and the chosen design)
are on a private design canvas, not in the repo.
**Scope:** the Sessions tab (rail id `chat`) after phase 2 (`2026-10-07-unidex-sessions-design.md`). Pick the host and
the model from the models each host really has; change the model, effort and access on any turn; a `/` menu of the
host's commands; the same picker in Vault chat; and a layout closer to Claude Code and the Codex app.

---

## 1. Problem

- **The model is free text.** `Model (optional)` is a text box (`SessionsTab.ts:577`). Nothing says which models a host has, and a typo fails only when the turn runs.
- **Host and model are fixed at the start.** The host chips show only for a new session, there is no effort control, and `session:send` takes no model (`schemas.ts:130`). A thread runs its whole life on its first model.
- **Access is a Claude-only checkbox.** **Allow commands** has no meaning on Codex, and neither host has a read-only mode.
- **Vault chat cannot choose.** It runs `reasoner.model` on Claude, or whatever `ask.js` resolves (`claudeAsk.ts`, `surfaces.ts:88,236`).
- **The tab reads like a log, not like Claude Code or Codex.** Tool rows are boxed cards, edits carry no +/− counts, plans are generic tool rows, and the list mixes Vault into the thread rows.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| U1 | **Layout B with C's list.** The list: **New session**, **Vault**, then each workspace folder with its threads (a host dot, a running mark, the age). The reader: one centred column (760 px): your prompt, the agent's text, tool calls as mono `⏺ Name(target)` / `⎿ result` lines, a Plan card, `✻ Working… (48s · esc to stop)`. Above it: `workspace / title`, the branch, **Review changes +a −b**, **Stop**. Below the composer, a status line: model · effort · access, turn and day spend, branch and files changed. | A (today's split, restyled): keeps the boxed log. C (three columns): the review pane crowds 1280 px and duplicates Review. |
| U2 | **One chip, one menu (Picker 2).** `● Claude Code · Opus 5.5 · High ▾` opens: a host switch (ready hosts only; the other greyed with its reason), search, the host's current models with older ones folded, the model's effort levels, **Custom model id…**, and where the list came from with ↻. | Three menus (Picker 1): three clicks. A toggle in the composer (Picker 3): takes the toolbar. |
| U3 | **Each host lists its own models; the runtime caches them.** `sessions.js catalog [--refresh]` writes `brain/_index/host-catalog.json`. Claude: one `initialize` control request to `claude -p --input-format stream-json --output-format stream-json`, which answers `models` and `commands` without calling a model (the Agent SDK's `supportedModels()` path). Codex: `codex debug models` (`visibility: "list"`, by `priority`) and the default model and effort from Codex's config. Fetched at app start when older than 24 h, and on ↻. | A list in `models.js`: stale at every model release. `~/.codex/models_cache.json`: an undocumented file in a host folder. Anthropic's `/v1/models`: needs an API key that subscription users do not have. |
| U4 | **A host that does not answer still works.** The menu shows its aliases (Claude: `default`, `opus`, `fable`, `sonnet`, `haiku`; Codex: "Codex default"), a line saying why the list is short, and **Custom model id…**, which is always there. | Refusing to start: one CLI hiccup would block every session. |
| U5 | **The cache keeps models and commands only.** `initialize` also answers the account (email, organisation): the runtime drops it before writing, and a test pins that. | Caching the whole answer. |
| U6 | **The host is fixed per thread; model, effort and access change on any turn.** `session:send` takes `model`, `effort` and `access`; each `prompt` event records them, and the timeline marks a change ("Next turn on GPT-6-Astra · Max"). In a thread the chip shows a lock on the host and the menu offers **New session on <other host>**. | Switching host mid-thread: each host resumes only its own sessions. |
| U7 | **Access levels replace Allow commands:** `access: "read" \| "edit" \| "run"` (default `edit`). Claude: `--permission-mode plan` / `acceptEdits` / `acceptEdits --allowedTools Bash`. Codex: `sandbox_mode="read-only"` / `"workspace-write"` / `"workspace-write"`. `allowCommands: true` still reads as `run` for one release. Checked live on 2026-10-07 (§5): read only writes nothing in the workspace on either host. | Keeping the checkbox: Claude only, and no read-only mode. |
| U8 | **`/` opens the host's commands.** Claude: `initialize`'s `commands` (name, description, argument hint), inserted as `/name `. Codex: the skills `codex debug prompt-input` renders, inserted as `$name ` (how Codex invokes a skill). The prompt goes to the host unchanged; the host expands it. | Expanding commands in the app: a second implementation of each host. |
| U9 | **Vault chat gets the same chip, always read only, and any host on any question** (each is one call; nothing resumes). Claude: `runClaudeAsk` with the chosen model and effort (its surface rule widens to the five Claude levels). Codex: `ask.js --local --host=codex --model=<m> --effort=<e>`, through `provider.js` `resolveProviderForRole({ prefer, model, effort })`, with no fallback to another provider. Its efforts are the ones its one-shot path takes (Claude `low…max`, Codex up to `xhigh`). Spend stays on the `reasoner.*` caps. | Making Vault a session in the vault root: widens S4 (sessions run only in `workspaces/<slug>`) to the whole vault, with tools. |
| U10 | **Edits are host-neutral.** An edit or patch line shows the file's `+a −b`; opening it shows that file's current diff from git (`git:diff`). Plans become a `plan` event from Claude's `TodoWrite` input and Codex's `todo_list` item. | Per-edit snippets from Claude's tool input: Codex reports only paths, so one host would get less. |
| U11 | **+/− counts.** `git:status` adds `added`/`removed` per file (`git diff --numstat HEAD`; untracked files count their lines). **Review changes** opens the existing review and commit card in a drawer over the conversation. | An always-open review pane (C). |
| U12 | **The last choice is remembered** per host (model, effort) and globally (host, access) in the HUD's settings, so a new session starts where you left off. | Always starting from the host's default. |
| U13 | **Two PRs:** 3a runtime and app (catalog, access, per-turn options, `plan` events, counts, `ask.js` host, channels); 3b the tab. Release 1.3.0 after 3b. | One PR: a runtime, app and HUD diff too large to review. |

## 3. What already exists (verified at `c9ecd2b`)

- **`headless.js` `sessionArgs`** (`:246`) passes `model` and `effort` on first and resumed turns for both hosts. `allowCommands` is Claude only, and Codex is always `workspace-write`. `CODEX_EFFORTS` is `minimal…xhigh`, so a Codex `max` or `ultra` is dropped today.
- **The app** (`services/sessions.ts`): the thread's meta line keeps the model and effort from `start`, and every turn reuses them. `SessionStartSchema` takes `model`, `effort` (`minimal…max`) and `allowCommands`; `SessionSendSchema` takes `thread`, `text` and `allowCommands` (`schemas.ts:122-130`).
- **`session-events.js`** emits `session`, `text`, `tool`, `tool_result`, `patch`, `usage`, `done`, `error`. `TodoWrite` is a generic tool; Codex `todo_list` is ignored.
- **`git.ts`** reads `status --porcelain=v2`, with no counts; `git:diff` returns one file's diff (2 MB cap).
- **Vault chat** (`ChatTab.ts`): `claude -p --model <reasoner.model> --tools ""` when Claude is logged in, else `ask.js --local`; the surface rules pin both argvs.
- **The hosts, on this machine:** Claude Code 2.1.293 answers `initialize` with 13 models (`value`, `displayName`, `description`, `supportedEffortLevels`) and 211 commands. codex-cli 0.158.0 lists 9 models in `debug models` (6 with `visibility: "list"`, efforts up to `ultra`), and `debug prompt-input` lists its skills. None of the three calls a model.

## 4. Design

### 4.1 The catalog

`brain/scripts/lib/host-catalog.js` (and `sessions.js catalog [--refresh] [--host h]`) resolves each enabled host's binary
(`headless.js resolveBin`), asks it as in U3 with a 20 s limit, and writes:

`{ schema: 1, hosts: { claude|codex: { ok, reason?, version, fetchedAt, defaultModel, defaultEffort, models: [{ id, name, description, efforts: [], main }], commands: [{ name, insert, description, hint? }] } } }`

`main` marks the host's current models (Claude: the aliases; Codex: the top three by priority); the rest fold under
**Older models**. Main runs it through a new channel, `session:catalog({ refresh? }) → Result<HostCatalog>`, one fetch at
a time, and answers from the cache when it is under 24 h old.

### 4.2 A turn's options

`session:start { workspace, host, text, model?, effort?, access? }` and `session:send { thread, text, model?, effort?,
access? }`. A send without them reuses the thread's last ones. The schema's effort list becomes
`minimal…ultra`; `sessionArgs` passes only the levels its host takes (Claude `low…max`; Codex `minimal…ultra`) and
refuses a read-only Claude turn with Bash. The `prompt` event gains `{ model, effort, access }`.

### 4.3 The tab (`SessionsTab.ts`, `ChatTab.ts`, new `ui/HostModelMenu.ts`, `ui/SlashMenu.ts`)

As U1 and the canvas. Keys: ⌘↵ sends, Esc stops a running turn when the composer has focus, ↑↓↵ drive the menus. The
sidebar's spend line reads the ledger's `session:*` rows against `sessions.perDayUsd` (the Cost tab's reader).

## 5. Host parity

1. **Entry point.** The Sessions tab in the app; no command, skill or verb is added. Both hosts appear when ready and enabled.
2. **Hooks.** None. Catalog calls run headless (`AOS_HEADLESS=1`; Codex `debug` runs no hooks).
3. **Model calls.** None for the catalog. Turns through `sessionArgs` (sessions caps); Vault through `runClaudeAsk` or `ask.js` → `provider.js` (reasoner caps).
4. **Session data.** The cache and the thread files the runtime and main write. No transcript is read.
5. **MCP.** None.
6. **Degradation.** A host that is off is greyed in the switch with its reason and `aos init --host <h>`. A host that does not answer the catalog shows its aliases (U4). An empty Codex skills list shows "Codex listed no skills"; typing `$name` still works.
7. **Docs.** README (Sessions), `app/README.md`, `SECURITY.md` (the read-only level, the catalog channel), `docs/app-smoke.md` items per host and their `COVERAGE.md` rows, CHANGELOG.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Sessions ▸ the chip ▸ a model; `/` for commands | `claude -p` `initialize` for the list; turns as today plus `plan` mode and `--allowedTools Bash` by level | the Codex side greyed: "Codex is off on this Mac" |
| Codex only (plugin · direct) | the same; `/` inserts `$skill` | `codex debug models` and `debug prompt-input` for the lists; `codex exec` with `read-only` or `workspace-write` | the Claude side greyed: "Claude Code is off on this Mac" |
| Both | the same; the host is fixed per thread, free per Vault question | the chosen host | — |

**Gaps (approved in phase 2, still shown):** on Codex, **Edit files** and **Edit and run commands** are the same
(commands always run inside the sandbox, without network), and the menu says so; a Codex turn has no per-turn dollar
cap (its cost is estimated after). **New:** both Codex lists come from `codex debug` subcommands; if a release changes
them, U4's fallback applies.

**Live findings (2026-10-07).** Claude's **Read only** (`--permission-mode plan`) ended cleanly in a headless turn and
wrote nothing in the workspace: its plan went to Claude Code's own plans folder, never the workspace. Codex's
`read-only` sandbox refused the write. A Read only turn on Haiku 5.5 at low effort cost about $0.16, mostly Claude Code's
own context; one on GPT-6-Luna at low about $0.03 (estimated).

## 6. Testing

- **Runtime:** `host-catalog` per host against recorded answers (no network), including the dropped account block; `sessionArgs` per access level and host; `plan` events from both hosts' fixtures; `provider.js` `prefer`.
- **App:** `session:catalog` and the new `start`/`send` fields against the fake CLIs; `git:status` counts on a temp repo; `sandbox.spec.ts` gains `catalog`.
- **e2e:** the picker (host switch, a model, effort), a mid-thread model change recorded on the prompt, the access menu, `/` inserting `/name` and `$name`, Vault on each host, and a Codex-only vault (`variants.spec.ts`).
- **Live (it spends; ask first):** one turn per host per access level, a `/` command per host, and a Vault question per host.

## 7. Out of scope

`@` file mentions and attachments; a context-window meter; switching the host of a thread; push and pull requests; a
`/` menu in Vault chat.
