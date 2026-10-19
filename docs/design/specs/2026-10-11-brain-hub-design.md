# UniDeX Brain: from a memory list to a hub that closes the loop — design

**Date:** 2026-10-11
**Status:** approved 2026-10-11 as written, on `feat/brain-runtime`; D6 confirmed: Archive only, no delete anywhere in the app. *(user)* rows are the user's answers from the interview and the option canvas; the rest are proposed technical decisions. Mockups are private.
**Base:** `main` at `7b24979` (1.7.0 plus the §8 record). Runtime (`brain/scripts`, `cli`), `plugin/` and the generated `codex-plugin/`, the HUD, the app's surface rules.
**Scope:** the Memory tab (rail id `memory`, `hud/src/views/MemoryTab.ts`) becomes **Brain**: review what agents wrote, find and read it, steer what every session starts with, and see the brain's shape and health. Code comments cite `brain-hub D<n>`.

---

## 1. Problem

At 7b24979, on a real vault (338 memories, about 13 new a day since auto-wrap started):

1. **Inflow without outflow:** auto-wrap writes `reviewed: false` (`lib/memory-writer.js:55`); 257 of 338 are unreviewed and nothing in the tab closes one. The only actions are Pulse's trail keep/edit/revert (`PulsePopup.ts:324-345`), and revert *deletes* the file with an unlocked MEMORY.md rewrite (`promoteTrail.ts:89-116`).
2. **Sprawl:** 8 near-duplicate pairs, one project memory per release step, a draft left behind after approval; `consolidate-memory` writes a proposal nothing applies (`sdk/consolidate-memory.js:58-66`, `plugin/commands/consolidate-memory.md:9-11`).
3. **Blind to use:** nothing records which memories reach an agent. `inject-context.js` injects BRAIN.md verbatim (`:52-62`) and BRAIN.md names titles, not paths (`build-brain-md.js:129-133`); the MCP `recall`/`memory_read` handlers log nothing (`mcp-server.js:71-84, :204-226`).
4. **The bootstrap is clogged:** BRAIN.md is about 875 of 850 tokens; Active context holds 21 projects plus 51 dropped, most of them shipped releases still tagged `status/active` (`build-brain-md.js:116-127`).
5. **Thin and dated:** a four-column list over title search (`memories.ts:79-85`), mono chips, a drawer with no actions; the graph is the HUD's own wikilink graph (`data/graph.ts`), not the runtime's graphify graph (5,265 nodes); drafts, patterns, reflections, BRAIN.md and SESSION.md live nowhere in the app.

## 2. Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | *(user)* **One Brain hub** replacing the Memory tab: memories, feedback drafts, patterns, reflections, BRAIN.md and SESSION.md, the graphify graph. | A read-only redesign. Actions without the hub. |
| D2 | *(user)* **Layout A, tabs across the top:** Review · Library · Bootstrap · Map · Health, each full width; Library is three panes (the right pane folds under 1100 px, all stack under 760 px). | B three panes with sections. C cockpit, then drill. |
| D3 | *(user)* **Review by session batch:** batches from `session:` frontmatter and the trail, named by the session index's title and host (`brain/_index/session-index.json`); "Keep the N new" (⇧K) keeps those with no duplicate flag; queues for Drafts and Older than 30 days; a one-time "Mark everything before <date> reviewed". | One card at a time. A bulk table. |
| D4 | *(user)* **Card actions** Keep, Edit, Merge, Archive, Pin; keys ↑↓ K E M A P ⇧K ⏎. Edit opens the file in the app's editor and changes nothing by itself. | Inline editing. |
| D5 | *(user)* **Archive tags in place:** `status/archived`, MEMORY.md line removed, out of recall, MOCs and BRAIN.md; Restore puts both back. | Move to `_archive/`. Move after 90 days. |
| D6 | **Nothing is deleted from the hub.** Pulse's revert (delete) gives way to Archive; Reject on a draft keeps today's behaviour (unlink, trail `reverted`, never drafted again; `feedback-drafts.js:96-102`). | Keeping delete. |
| D7 | **Merge and "keep the older one"** mark the losers `status/superseded` with `superseded_by: <path>` (the shape a session wrote by hand on 2026-10-11), collapse their MEMORY.md lines into the winner's, and log the trail; Restore undoes it. | Deleting or archiving sources. |
| D8 | *(user)* **Usage log, paths and counts only:** `brain/_index/memory-usage.jsonl` rows `{ts, host, how, path}`, `how` ∈ injected, recalled, read; no prompts or queries; on with `telemetry.enabled`; rows older than `memory.usageDays` fold into `memory-usage-rollup.json` at scan. | Also the query. Opt-in only. |
| D9 | **Who logs:** `inject-context.js` once per session (the paths BRAIN.md was built from, D10, plus recall-wake's paths); the MCP `recall` hits and `memory_read` path. The host comes from `lib/host.js`; `plugin/.mcp.json` gains `env: {AOS_HOST: claude}` so neither server guesses. The recall preview and the HUD never log. | The PostToolUse telemetry hook (inputs redacted, payloads differ per host). |
| D10 | **`build-brain-md.js` writes `brain/_index/brain-sources.json`:** per section its source paths, tokens and the omitted paths. | Parsing BRAIN.md titles back to paths. |
| D11 | **Duplicates without a model:** title Jaccard (`noise-gate.js:20-26`), BM25 cosine over the recall index's `tf`, and embedding cosine when `embed-index.json` exists (Ollama); pairs ≥ `memory.dupScore` flag, ≥ `memory.clusterMin` linked memories form a cluster; "Not duplicates" is remembered (`brain/_index/memory-notdup.json`). | A model per pair. The HUD computing it. |
| D12 | **One runtime cache, `brain/_index/brain-hub.json`,** written by scan-vault: batches, duplicate pairs and clusters, usage per path (7 and 30 days, last), hygiene findings, active projects that look shipped. The HUD reads it plus the memory files. | Computing in the HUD. |
| D13 | **CLI verbs `aos memory <verb> --json`** for every hub action, usable from either host's sessions (§4). | HUD writes through the adapter (today's trail). |
| D14 | **A new surface `brain`,** `writes: []`, argv rules for the verbs, `sdk/recall-cli.js` (preview) and `build-brain-md.js`; `pulse` drops its `brain/memory/**`, `MEMORY.md` and trail writes (PR 2); `capture` is unchanged; `verified: true` after a live check per host. | Widening `pulse`. HUD writes. |
| D15 | *(user)* **Pulse summarises, the hub acts:** one Brain tile (today, to review, drafts, BRAIN.md %), each number a deep link into a mode; the trail and drafts row move to the hub; Needs-you items link to Review. | Both places act. Dropping the tile. |
| D16 | **Rail:** label Brain, icon brain, id stays `memory` (links, commands and tests hold); the badge counts memories written since Review was last opened (a per-machine marker), so it reaches zero. | Renaming the id. Badging the backlog. |
| D17 | **Bootstrap** shows budget bars (BRAIN.md, SESSION.md, recall-wake), BRAIN.md by section with tokens, Pin/Unpin and Mark complete (through `set`, then `build-brain-md.js`), and "looks shipped" suggestions: an active project naming a released version, "shipped" or "released", or superseded (D7). Suggestions only. | Auto-completing projects. |
| D18 | **Recall preview** runs `sdk/recall-cli.js` on the typed text: the same hybrid/BM25 path agents use. | A new MCP tool. |
| D19 | **Map from graphify:** scan writes `brain/_index/brain-map.json` (communities holding ≥ `memory.mapMin` memories, index hubs MEMORY.md, MOC-* and BRAIN.md removed, each named by its most-linked memory, edge counts between them, ≤ 12 neighbours per memory). Views: Communities, Around a memory, Every node (today's force view, memory nodes only). Graph off: an empty state naming `aos graph on`. | The HUD parsing the 5 MB `graph.json`. Dropping the force view. |
| D20 | **Health:** six tiles; duplicates and clusters; hygiene fixes as `aos memory fix <kind>` with a dry-run preview; dead weight once `memory.neverUsedDays` of log exist; the sweep (D22). | A report file. |
| D21 | *(user)* **AI merge draft:** `merge-draft` makes one `provider.js` call per click, feature `memory-merge` (hook caps, strict schema), shows its estimate before and spend after; nothing is written until Save. Under `none` Merge opens both files side by side. | The reasoner. Merging without review. |
| D22 | *(user)* **Consolidation sweep:** `sweep` asks `provider.js` (feature `reason:memory-sweep`, reasoner cap, strict schema) for Merge, Archive and Retitle suggestions, kept in `brain/_index/memory-sweep.json`; each card applies through the same verbs. `/consolidate-memory` keeps working and points at the hub. Off under `none`. | Applying the markdown draft. |
| D23 | **Feel:** typographic, `--udx-*` tokens, both themes, colour only for state, `.aos-brain-*` classes; the Memory inspector pop-out stays. | Restyling shared classes. |
| D24 | *(user)* **Four PRs, each shippable** (§4). | Three. Review first, end to end. |
| D25 | **Config `memory.*`:** `usageDays` 90, `neverUsedDays` 30, `dupScore` 0.8, `clusterMin` 3, `mapMin` 8. | Hard-coded. |

## 3. What already exists (verified at `7b24979`)

- **Writers:** `writeMemory` throws on an existing file, writes frontmatter non-atomically, inserts the MEMORY.md line through `fsx.updateSync` with no dedupe (`memory-writer.js:46-68`, `memory-index.js:19-44`). Trail: `appendTrail`/`readTrail`/`revertedSlugs`, unlocked append (`promote-log.js:8-13`).
- **Safe-write helpers** (Spaces PR 3): `fsx.writeAtomic`, `withLockSync`, `updateSync` (`fsx.js:33, :68, :113`); `lstatOrNull`, `regularText` (O_NOFOLLOW), `runtimeDir`, `emit`, `UsageError` (`cli/workspace.js:96-303`); `--expect` hashing (`workspace-manifest.js:250-254, :447-458`).
- **Drafts:** `feedback-apply.js --list|--approve|--reject`, text output only, admitted by no surface (`feedback-apply.js:12-25`, `feedback-drafts.js:85-102`).
- **Search:** `recall.js` exports `loadIndex`, `queryRecall`, `queryRecallHybrid`, `loadEmbedIndex`, `tokenize` (`:275-279`); its cosine `dot()` is private (`:185-190`); embeddings only under Ollama (`embed-vault.js:55-58`).
- **Model calls:** a feature is a free string; unprefixed features count against the hook caps (`spend-ledger.js:61`, `provider.js:86-91`); precedent `workspace-draft` (`lib/workspace-draft.js:35, :248-299`).
- **App:** the HUD runs verbs through `plugin.aosJson` → `runAosJson` (`main.ts:263-265`, `aosRun.ts:61-74`); the `spaces` surface's argv rules (`surfaces.ts:118-128, :216-233`); `pulse` writes memory (`:198-215`). The rail entry `WorkbenchView.ts:56`; e2e pins ids only (`harness.ts:430-436`).

## 4. Design

**PR 1: runtime** (`feat/brain-runtime`). *After it ships:* every action exists as a verb for either host's sessions; the caches and usage log fill; nothing in the app changes.
- **Verbs** (`cli/memory.js`, dispatched like `workspace`): `list --json`; `keep PATH… --json`; `set PATH --set JSON_OBJ --expect HASH [--dry-run] --json` (keys `pin`, `status` ∈ active·complete·paused, `description`); `archive|restore PATH… --json`; `supersede PATH --by PATH --json`; `draft approve|reject SLUG --json`; `notdup PATH PATH --json`. `PATH` is `brain/memory/<type>/<slug>.md`, a direct child of a known type folder.
- **Caches:** `brain-hub.json` (D12), `brain-sources.json` (D10), `memory-usage.jsonl` and its rollup (D8–D9). Recall, MOCs and BRAIN.md skip `status/archived` and `status/superseded`.
- **Fixes on the way:** MEMORY.md writes dedupe a path's line; the trail appends under `fsx.appendLineSync`.

**PR 2: hub shell, Review and Library.** *After it ships:* the Brain tab with all five tabs (Bootstrap, Map, Health show PR 3 stand-ins), Review and Library complete, the Pulse tile, the rail badge, the `brain` surface. `MemoryTab.ts` gives way to `BrainTab.ts` and `views/brain/*`.

**PR 3: Bootstrap, Map and Health.** `fix <kind> [--dry-run] --json` with kinds `sources`, `types`, `descriptions`, `index`, `drafts` (labels, the old `type:` shape, descriptions copied from MEMORY.md, misfiled or missing index lines, approved drafts left behind); `brain-map.json`; the recall preview.

**PR 4: AI helpers.** `merge-draft PATH PATH… --json` (fields and `baseHashes`; nothing written); `merge PATH… --into JSON_OBJ --expect HASHES --json` (writes the winner, D7 for the rest); `sweep --json`. Cost estimates use the provider's pricing tables.

**Accessibility:** mode tabs are a `tablist`; batch and result rows are buttons with `aria-selected`; budget bars are `progressbar`s; every coloured dot has a text label; every key has a button.

## 5. Host parity

1. **Entry point:** the Brain tab; `aos memory <verb>` in any session or terminal on either host. `/consolidate-memory` (`$agenticos:consolidate-memory`, `$consolidate-memory` direct) points at the hub. No new command, skill or MCP tool.
2. **Hooks:** no hook command changes; `inject-context` logs inside the existing UserPromptSubmit hook, so nobody re-trusts under `/hooks`.
3. **Model calls:** merge drafts and the sweep only, through `provider.js` per host (matrix).
4. **Session data:** none read directly; batch names come from `session-index.json`, written by the runtime from both formats.
5. **MCP:** no new tool. `recall` and `memory_read` log usage on both servers; `plugin/.mcp.json` sets `AOS_HOST=claude` (Codex's is generated with `codex`).
6. **Degradation:** no Ollama: meaning similarity uses BM25 only, labelled; graph off: Map's empty state; telemetry off: use columns hidden with the reason; provider `none`: manual merge, sweep off; a hook cap reached: the estimate says so and Merge falls back to side by side.
7. **Docs:** README (the Memory line, "Everyday commands" `aos memory`), `docs/install.md` Hosts, `vault-template/AGENTICOS.md` (archived and superseded statuses, within 9,000 characters), app-smoke items per host and its `## Codex host`, COVERAGE, SECURITY.md, CHANGELOG.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | The Brain tab; `aos memory …` in a session or terminal | Usage logged with `host: claude` from the hook and the MCP server; merge and sweep: Ollama, else `claude` (`claude.model`, capped) | `none` or a cap: side-by-side merge, sweep off with the reason |
| Codex only (plugin · direct) | The Brain tab; `aos memory …` | The same, `host: codex` (plugin and direct wiring both set `AOS_HOST=codex`); merge and sweep: Ollama, a logged-in `claude`, else Codex (low effort, daily cap), labelled by who answered | The same fallbacks; Codex's cost is an estimate after the call (codex-parity D5) |
| Both | Both forms | Rows from both hosts in one log; Use shows `claude n · codex n`; provider `auto` | A host not logged in: its calls skipped, the other host answers |

No cell differs beyond the provider chain each host already has; no parity gap widens.

## 6. Security

- **The new power** (PR 1, PR 3, PR 4): the verbs write frontmatter lines (`reviewed`, `pin`, the `status/` tag, `superseded_by`, `description`, `type`) of existing memories, one new memory per merge, `MEMORY.md`, and `brain/_index/**`; `draft approve|reject` keeps today's writes. Nothing is deleted except a rejected or already-applied draft.
- **Validation in the runtime:** `PATH` matches `^brain/memory/(user|feedback|projects|reference)/[a-z0-9][a-z0-9-]{0,80}\.md$`, is a regular file opened O_NOFOLLOW with its realpath inside the vault; `SLUG` matches the drafts folder the same way; `set` checks keys, types, lengths and control characters; `--expect` refuses a changed file; writes are atomic and locked; merge bodies are capped and frontmatter-escaped.
- **The page:** no new IPC; verbs go `runAosJson` → `proc:spawn` → `WritePolicy.canSpawn`; Archive of more than one, Merge and fixes confirm in a `ConfirmModal`; `pulse` narrows (D14). **SECURITY.md:** rows for the verbs, the two model calls and the usage log.

## 7. Tests and docs

**PR 1:** every verb and refusal (symlink, outside path, changed hash, unknown key), containment, usage logging per host (`AOS_HOST` injected, both servers' env), `brain-sources.json`, duplicate scoring with and without embeddings, rollup, recall skipping archived; both rehearsals assert usage rows. **PR 2:** a `brainModel` unit suite, the memory part of `spaces-memory-runs.spec.ts` rewritten into `brain.spec.ts`, a Codex-only variant, the Pulse tile, screens (`graph.png` → `brain.png`). **PR 3:** fixes with dry runs, `brain-map.json`, e2e per mode. **PR 4:** fake providers per host, `none`, a hit cap, e2e for merge and a sweep card, the live check per host.

## 8. Out of scope

Rich editing inside the hub; renaming slugs; automatic archiving by use; authoring reflections or patterns beyond today's modals; usage of memories read by plain file tools (only `memory_read`, `recall` and injection count); a CLI picker for review; a release.
