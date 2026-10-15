# UniDeX 2.0, track A: local-first background work, a hosted Chief of Staff — design

**Date:** 2026-10-14
**Status:** approved 2026-10-14 as written. *(user)* rows are the owner's answers from the decision interview; the rest are proposed technical decisions.
**Base:** `main` at `b63e14c` (1.9.0 plus the §8 record). Runtime (`brain/scripts`, `cli`), the HUD, the app's wizard and surface rules. No `plugin/` hook changes.
**Plan:** `docs/superpowers/plans/2026-10-14-unidex-2-0.md` (PRs 1–4 and 9). Sibling specs: `2026-10-14-install-and-import-design.md` (B), `2026-10-14-guided-tour-design.md` (C). Code comments cite `local-first A<n>`.

---

## 1. Problem (verified at b63e14c)

1. **Background work reaches hosted models.** The `auto` chain falls to Claude, then Codex, whenever Ollama does not answer (`sdk/lib/provider.js:239-281`); `resolveProviderForRole` skips Ollama for every Claude-role call (`:304-352`); the sweep refuses Ollama outright (`lib/memory-ai.js:200-207`); the graph pass hard-codes `--backend claude-cli` (`graph-build.js:216`); the Claude login check is a billed `claude -p` on `haiku` (`sdk/lib/claude-cli.js:166-178`).
2. **No routine can run locally.** Duties spawn `claude -p`/`codex exec` (`persona/run-duty.sh:262-271`); prompt routines likewise (`routines/run-routine.js:113-124`); `ollama.js` has no tool calling.
3. **`claude.model` means five things:** hook fallback, duty fallback, prompt-routine default, graph model, sweep model. `run-duty.sh:73` takes "the first `model` key" in the user file.
4. **Defaults never reach existing installs.** Init and upgrade materialize every default into `brain/config.json` (`cli/aos.js:1013, 1230-1236`), and `buildUserConfig` hard-codes `provider: 'auto'`, `claude.model: 'haiku'` into the user file (`:689-699`). A migration cannot tell a choice from a copied default.
5. **The tick never skips:** `beatsKey` includes every routine's `lastRunAt` (`persona/tick.js:140-144`), and the heartbeat, the briefing and the tick itself bump theirs every run. On one real vault: 484 beats, 0 skipped, about $30 a week on a Sonnet-class model.
6. **One model for every Mac:** `qwen3.5:9b` regardless of RAM; workhorse and embedder are env-only (`sdk/lib/models.js:19-24`); `auto` never checks that the model is pulled; `keepAlive: -1` pins about 7 GB forever.
7. **Sessions is coupled to the background provider:** its rail button hides when `provider-state` is `none` (`obsidian-plugin/main.ts:283-285`). Local-only plus Ollama down would hide Sessions with a host signed in.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| A1 | *(user)* **Every unattended call runs on the local engine:** Stop summary, auto-wrap and the correction detector, scan insights and file maps, embeddings and recall, the Pulse briefing, the graph semantic pass. No hosted call unless the user turns on `local.hostedFallback`. | Today's auto chain. Local only while Ollama is up. |
| A2 | *(user)* **AI buttons default to local:** Merge with AI, Draft workspace.md, Map now, Regenerate, the Brain sweep and Consolidate with AI, standup/compress `--local`. Ask brain, reflect-week, consolidate-memory and Vault chat default to local with a per-feature switch `ai.<feature>: local\|host`. Sessions, terminal agents, cross-review, handoff and team seats stay on the hosts. | Background only. Everything local. |
| A3 | *(user)* **No-local fallback: queue + heuristic.** Wraps spool to `wrap-queue` and retry when the engine is back; summaries, insights, file maps and the briefing go heuristic; recall uses BM25; the graph pass waits a day. `local.hostedFallback: false` by default. A button the user presses may offer "Run once on Claude/Codex" with its cap. | Capped hosted fallback. Stop and alert. |
| A4 | *(user)* **The Chief of Staff runs hosted:** Claude Code · `claude-opus-5-5` or Codex · `gpt-6-sol`. The wizard preselects Claude when ready, else Codex. With both hosts, a duty that cannot start on the primary (signed out, capped, CLI missing) fails over to the other host's CoS model. | Codex primary always. No failover. |
| A5 | *(user)* **The tick becomes local triage.** Rules first: a signature of routine *status changes and failures* (never run times), tracked repos' HEADs (the vault's own repo by content signals, not commits), flags, proposals, inbox. On a real change, the local model decides whether it merits a CoS run and journals a one-line reason. If local is down, any real change wakes the CoS. | All duties hosted with a fixed skip. Dropping the tick. |
| A6 | *(user)* **User routines name their engine and model:** frontmatter `engine: local\|claude\|codex` + `model`. A routine without `engine` keeps today's runner resolution, untouched by any migration. | Hosted-only prompt routines. |
| A7 | *(user)* **A built-in local agent runner,** `lib/local-agent.js`: Ollama `/api/chat` with `tools`; tools `read_file`, `list_files`, `grep`, `write_file` (only inside the routine's `writes` globs, through `duty-guard.js` rules), `notify`; turn and wall-clock limits from the routine; journal and ledger rows like any run. | Host CLIs pointed at Ollama (needs a CLI). |
| A8 | *(user)* **The app manages Ollama** (install and pull are track B): reuse a present Ollama; RAM tiers pick the model. Advanced: any OpenAI-compatible server (LM Studio, llama.cpp) via `local.engine: openai` + `local.url`. | Bundling llama.cpp. Bring your own. |
| A9 | *(user)* **Existing installs: ask once, default local.** An upgrade from < 2.0.0 records a pending `local-first` migration; the app shows a "Go local" card; the CLI asks on a TTY. "Keep my settings" changes nothing; Settings can switch later; Undo restores the backup. | Silent migration. Only untouched defaults. |
| A10 | **New provider value `local`** (new installs' default). `auto`, `ollama`, `claude`, `codex`, `none` stay legal; "Keep my settings" keeps `auto`. | Redefining `auto`. |
| A11 | **Config by role, not by host:** `local.{engine,url,model,embedder,keepAlive,hostedFallback,onBattery}`; `ai.{chat,ask,reflectWeek,consolidate}`; the CoS on `persona.{runner,model,codexModel,effort,failover}` with defaults `claude-opus-5-5` / `gpt-6-sol` from a new `chief` role in `models.js`. `claude.model` shrinks to "the hosted fallback model". | A new `chief.*` tree beside `persona.*`. |
| A12 | **RAM tiers** (`os.totalmem()`): < 12 GB → `qwen3.5:4b` (3.3 GB), else `qwen3.5:9b` (6.6 GB); embedder `qwen3-embedding:0.6b`. `keepAlive` `-1` at ≥ 24 GB, `5m` below. `local.model` overrides. | One tag for every Mac. |
| A13 | **Ready means pulled:** resolving `local` checks `/api/tags` lists the model (cached 60 s); doctor and Settings show engine, model, tier, pulled. | Reachability only. |
| A14 | **The graph pass on graphify's `ollama` backend** (`OLLAMA_BASE_URL=<url>/v1`, `OLLAMA_MODEL`); `semanticState` stops disabling it under `ollama`. Verify the pinned graphify's flag in PR 2. | Keeping the Claude shim. |
| A15 | **The sweep goes local by chunking:** it sends brain-hub's duplicate clusters (`brain-hub.json`, brain-hub D11), each within the model's context, instead of the whole brain; the `ollama-only` refusal goes. | Keeping the sweep hosted. |
| A16 | **No billed login probe:** Claude login comes from `claude auth status --json` (free; the wizard already uses it). | The `haiku` probe. |
| A17 | **Sessions follows the hosts:** `chatAvailable()` means "an enabled host is signed in", not the background provider. | Coupling kept. |
| A18 | **Local calls are ledgered at $0** (`provider: ollama`, the feature), so Pulse shows "N local calls today" and spend stays honest. Heavy jobs (graph pass, history digest) defer on battery (`local.onBattery: defer`). | Unlogged local work. |

## 3. What already exists

`provider.js` modes and per-feature labels; `models.js` roles; `ollama.js` chat/embed with JSON-schema `format`; `wrap-queue.js` spool and reconcile; `headless.js` `resolveRunner`/`runnerArgs`; `duty-guard.js` write scopes; `NEW_ROUTINES` + `ctx.from` version gating (`cli/aos.js:1067-1100`); the spend ledger and caps; brain-hub duplicate clusters; the Routines tab editor's free-text model field (`RoutinesTab.ts:280-282`).

## 4. Design

**Routing in 2.0 (defaults):**

| Work | Trigger | Engine | Local down |
|---|---|---|---|
| Summary, extraction, corrections | Stop / SessionEnd / reconcile | local | heuristic summary; wraps queued |
| Insights, file maps, embeddings, recall | scan, recall | local | heuristic; BM25 |
| Pulse briefing | every 30 min | local | facts-only briefing |
| Graph semantic pass | daily, on AC power | local (graphify `ollama`) | deferred |
| AI buttons, sweep | user | local | explains; "Run once on Claude/Codex" |
| Ask, reflect-week, consolidate, Vault chat | user | `ai.<feature>` (local) | same |
| Tick | hourly | rules → local triage → wakes CoS | rules only |
| sitrep, monitor, reflect-daily, reflect, woken tick | schedule | CoS model, failover | skipped + flagged |
| User routines | schedule | the routine's `engine`/`model` | that engine's rule |
| Sessions, terminal, cross-review, teams | user | host | unchanged |

**Provider.** `resolveProvider` gains `m === 'local'`: the local engine when its model is pulled, else `hostedFallback ? <today's Claude→Codex legs> : none('local-down')`. `resolveProviderForRole` honours `ai.<feature>` and the CoS role. `none('local-down')` is a new reason the callers treat as "queue or heuristic", never a failure.

**CoS.** `headless.js` gains `resolveChief(cfg)` → `{host, model, effort}` with failover order; `run-duty.sh` reads it through a node helper (no flat scan) and passes `--model`/`-m`; plists bake the resolved values and `aos routines sync` re-renders. The tick routine becomes `kind: command` (`persona/tick.js --triage`), which itself starts the duty run when it wakes the CoS.

**Local runner.** `run-routine.js` dispatches `engine: local` to `local-agent.js`: a system prompt from the routine body, tool schemas, a loop bounded by `maxTurns` (default 24) and `timeoutSec`, tool results truncated to the context budget, a final message written where the routine says. Writes outside `writes` are refused and journalled. Ledger row: `provider: ollama`, `usd: 0`. The Routines editor gets an engine select (Local · Claude · Codex, only enabled ones) and a model select (pulled Ollama tags; `CLAUDE_MODELS`; the Codex catalog), with a note that small local models may struggle with long multi-step routines.

**Migration** (`aos migrate local-first [--apply [--chief] | --decline | --undo | --status]`). `cli/migrations.js` holds `MIGRATIONS = [{id, since}]` (generalizing `NEW_ROUTINES`); `aos upgrade` from < `since` writes `brain/_index/migrations.json` `{id, state: 'pending'}` and, on a TTY, asks. Apply backs up the touched keys to `brain/_index/migrations/<id>-<ts>.json`, then sets `provider: local` and `ai.*` in **both** the user file and `brain/config.json`, with `--chief` sets the CoS defaults, rewrites the shipped `tick.md` only when it still matches its shipped hash (else a notification explains), and re-renders schedules. It never touches a user routine. The HUD's launch sequence (track C, C11) shows the card: what moves local, what stays hosted, last 7 days' background spend from the ledger, the model download if missing, a checked "Move the Chief of Staff to Opus 5.5 / gpt-6-sol". It runs the verb through a new surface `migrate` in `app/src/shared/surfaces.ts`.

## 5. Host parity

1. **Entry point:** no in-session command. `aos migrate`, `aos local status|pull|use <model>` (host-neutral) and Settings ▸ Local engine.
2. **Hooks:** commands unchanged, so no `/hooks` re-trust.
3. **Model calls:** one-shot through `provider.js` (`local`); agent jobs through `headless.js` (`local` runner, `resolveChief`). Claude only: CoS on `claude -p --model claude-opus-5-5`; Codex only: `codex exec -m gpt-6-sol`; no host: the CoS waits; `provider: none`: heuristics, as today.
4. **Session data:** unchanged; the tick reads caches.
5. **MCP:** no new tool.
6. **Degradation:** below.
7. **Docs:** README "Everyday commands", `docs/install.md` Providers, `vault-template/AGENTICOS.md` Providers (≤ 9,000 chars), `docs/chief-of-staff.md`, `docs/cost.md`, app-smoke items per host.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | nothing; Settings ▸ Local engine, `aos local` | background on local; duties on `claude-opus-5-5` | duty skipped + flagged "Claude unavailable"; local down: heuristics, queue |
| Codex only (plugin · direct) | same | background on local; duties on `gpt-6-sol` | same, with Codex wording |
| Both | same | duties on the primary, failover to the other | both down: skipped + flagged |
| No host (track B) | same | background on local; no duties | Pulse: "Add Claude Code or Codex to start your Chief of Staff" |

## 6. Out of scope

Local models for Sessions, terminal agents, cross-review or team seats; bundling an engine; managing an engine on Linux (the CLI keeps working with a user-installed Ollama); fine-tuning; a model-quality benchmark beyond fixture tests of extraction, triage and the runner's tool loop.
