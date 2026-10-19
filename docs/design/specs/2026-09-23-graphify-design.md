# graphify as part of the brain — design

Date: 2026-09-23 · Branch: `feat/graphify` · Verified against `6120701` · Spike: §4.7 (graphify 0.9.66)

## 1. Problem

The brain answers *content* questions well (`recall`: BM25 + vectors + one hop of `[[links]]`), but not
*structure* ones: what connects two notes, which notes are hubs, which clusters exist, what sits two hops
from a project. graphify (github.com/Graphify-Labs/graphify, PyPI `graphifyy`, Apache-2.0) builds exactly
that graph — pages, headings, `[[wiki-links]]`, markdown links and code structure — clusters it into
communities, and answers path / neighbour / hub queries. Its model-assisted pass adds concept nodes and
inferred edges on top. The runtime already carries a reader for its output (`brain/scripts/graph-snapshot.js`),
but nothing installs graphify, nothing builds a graph, and the reader looks in the wrong place, so the
"Graph pulse" never fires.

This change makes graphify part of what `aos init` installs:
- a pinned binary;
- a vault graph kept fresh in the background: a free structural pass after every scan, plus a daily semantic pass on its own budget;
- graph tools on the existing `agenticos` MCP server.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | On by default. `uv` becomes a hard `aos init` prerequisite (`fail` in doctor), with an `AOS_UV_BIN` seam like the others. `aos graph off` stops background rebuilds; the binary stays. | Opt-in module (`aos graph enable`, like `aos cost enable`). | Owner decision (2026-09-23). Spec `2026-09-22-mandatory-prereqs` already made the tools the brain is designed around hard requirements. |
| D2 | Install with `uv tool install 'graphifyy==<pin>'` into an AgenticOS-owned tool dir (`UV_TOOL_DIR`/`UV_TOOL_BIN_DIR` under `${XDG_DATA_HOME:-~/.local/share}/agenticos/graphify/`). The binary path is recorded as `graph.bin` in `agenticos.json`. | Plain `uv tool install`; `uvx` on every run; `python3 -m venv` + pip. | Plain install collides with a user's own `graphify` on PATH. `uvx` re-resolves per run and breaks offline after `uv cache prune`. graphifyy needs Python ≥ 3.10, and a stock macOS `python3` is 3.9; uv brings its own. The path is recorded because hooks spawn it (prereqs D8). |
| D3 | The version is pinned as a constant in `cli/graph-cmd.js` (`PIN`, `0.9.66` after the spike), not a config key: `aos upgrade` copies every default into `brain/config.json`, where a user value wins, so a pin kept in config would freeze at the first upgrade. `aos upgrade` reinstalls when the installed version differs. The pin moves only in a release, after re-running the spike checks. graphify's own `install`, `claude install`, `hook install`, `check-update` and `cluster-only` are never run. | Track latest. | Upstream releases every 1–3 days, and each version drops the AST cache. `install`/`claude install` edit the global `CLAUDE.md` and add PreToolUse hooks whose read nudge fires on every `.md` read. `cluster-only` calls a model unless `--no-label` is passed. |
| D4 | Queries go through **new tools on the existing `agenticos` MCP server**, which reads `graph.json` in Node: `graph_query`, `graph_neighbors`, `graph_path`, `graph_overview`. | Register graphify's own MCP server (`graphify-mcp`). | Its tools take a free `project_path` that loads any `graph.json` on disk (still open at 0.9.66). It needs the `[mcp]` extra. Tests pin `.mcp.json` to one server, and a plugin cannot declare a server conditionally. One server also reaches the Codex plugin, and no Python runs at query time. |
| D5 | **Two background passes on one worker.** The *structural* pass (`graphify update`: no model, $0, ~1.4 s) runs after every scan. The *semantic* pass (`graphify extract`, incremental: only new or changed notes reach the model) runs at most every `graph.semantic.everyHours` (24). `aos graph build --semantic` runs the same pass now. | Semantic only when the user runs it. | Owner decision (2026-09-23). Spike F: `update` preserves the semantic layer, so the two passes can alternate safely. |
| D6 | The semantic backend is **`claude-cli` through an AgenticOS `claude` shim** placed first on the child's PATH. The shim appends the lean headless flags from `sdk/lib/claude-cli.js`: `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, a short `--system-prompt`, forced `--model` `claude.model`, and `--max-budget-usd` `graph.semantic.perCallUsd`. The env gets `AOS_HEADLESS=1` and `MAX_THINKING_TOKENS=0`. | graphify's `ollama` backend; `claude-cli` without the shim. | Spike E: Ollama's `/v1` ignores graphify's context size (prompts cut to 4,095 tokens), thinking cannot be disabled, and the working custom-provider route ran about 54 s per note. Spike G: without the shim every chunk loads the user's hooks, plugins, MCP servers and `CLAUDE.md` (AgenticOS hooks write into the vault), costs about 42k input tokens of overhead, and has no budget flag. With the shim: 2.2k in, 1.2k out, 10.7 s, $0.008 on the same fixture. |
| D7 | Rebuilds run as a `graph-build` stage in `scan-vault` after `embed-vault`. The structural pass runs inline (about 2 s): `scan-vault` is already detached (`lib/detach.js`) when a hook starts it, so the 15 s SessionEnd cap never waits. The semantic pass (slice 3) spawns a detached worker. One lock covers both graphify commands, because `extract` takes no lock of its own. It is a JSON file created with `O_EXCL` that names its owner (pass, pid, a random id, start, and a deadline from the owner's own timeout); a waiter breaks it only when that pid is dead or that deadline has passed, and a pass releases only its own. (0.11.0 used a directory lock judged stale by the waiter's timeout, so a 3-minute structural wait broke a live 30-minute semantic run's lock; fixed in 0.11.1.) The kill is `graph.timeoutSec` / `graph.semantic.timeoutSec`. | graphify's git post-commit hook; a seeded routine. | The hook writes `.gitattributes` and a merge driver into the vault repo. Seed routines never reach existing vaults (`aos.js:1017-1025`). A stage shows in `aos status` and the HUD pipeline list for free. |
| D8 | The corpus is always the vault root, passed explicitly, minus a seeded `.graphifyignore`. Output goes to `<vault>/brain/graphify-out` via an absolute `GRAPHIFY_OUT`. `GRAPHIFY_NO_BACKUP=1` is set, and the worker keeps one `graph.json.prev` instead. The vault `_gitignore` gains `brain/graphify-out/`. | Graph `brain/` only; graphify's dated backups. | Spike risk 5: a different root re-keys node paths and keeps stale nodes. `brain/`-only misses `MEMORY.md`, `TODO.md` and `persona/`. Spike: graphify adds one ~2 MB backup per changed day and never prunes. |
| D9 | Claude learns the tools from one plugin skill, `graph`: when to use `graph_*` (relationships) versus `recall` (content). `AGENTICOS.md` gains one line. | Ship upstream's `SKILL.md`. | Upstream's skill drives graphify's CLI and pipeline; ours only needs to route between two MCP tool families. |
| D10 | Spend is a **fourth metered family**, `graph:`, with its own caps: `graph.semantic.perCallUsd` (0.25) and `perDayUsd` (1). It is added to `HOOK_EXCLUDE`. The shim checks today's `graph:` spend before every call and exits 1 without spawning once the cap is reached. After each call it records one `graph:semantic` row from the envelope's `total_cost_usd` and usage. `GRAPHIFY_MAX_RETRY_DEPTH=0` means at most one call per chunk. `--token-budget` `graph.semantic.tokenBudget` (20000) keeps output well under the model's limit. `--allow-partial` merges what succeeded. | Count graph runs against `claude.perDayUsd`; ledger from `cost.json`. | That $0.50 cap is for hooks, and one first pass would starve auto-wrap. Persona duties, the reasoner and routines each have their own family (`spend-ledger.js:57`). Spike E: headless `extract` writes no `cost.json` and no USD. A refused chunk stays uncached and is retried at the next due run, so a large first pass drains across days inside the cap. |
| D11 | `graph.semantic.enabled` is `"auto"`: the pass runs under provider `auto` or `claude` and is off under an explicit `ollama` or `none`. `true` or `false` override that. | Always run whenever a Claude login exists. | An explicit `ollama` or `none` is a user saying "no background model calls to Anthropic". `auto` already allows the Claude provider. |
| D12 | `sdk/lib/claude-cli.js` sets `MAX_THINKING_TOKENS=0` for every call that passes **no** `effort`: hook calls and the graph shim. Calls that pass an effort, such as the reasoner, keep thinking. | Set it for every call in `headlessEnv`; leave hook calls alone. | Owner decision (2026-09-23), from spike G: thinking was 82% of a Haiku extraction's output and cost ($0.069 → $0.008). The reasoner chooses its effort deliberately, and a blanket env var would silently override that. PR 3 measures one real hook call before and after. |

## 3. What already exists (at `6120701`)

- `brain/scripts/graph-snapshot.js` (32 lines): prints a "Graph pulse" from `PATHS.VAULT/graphify-out/graph.json` (`:7`). That is the wrong path, and nothing dispatches it.
- `cli/aos.js`:
  - `seam()` `:183`, `pythonBin()` `:189`, `ollamaBin()` `:215`.
  - `doctor()` `:304` with `add(name, ok, detail, level)` `:306`; the conditional row pattern is the cost analyzer `:416`.
  - `buildUserConfig` `:568`, `vendorRuntime` `:631`, `init` `:876` (prereq gates `:920-928`).
  - `upgrade` `:1067` (defaults merge, user wins `:1105-1111`), `BOOL_FLAGS` `:1240`, verb switch `:1286`.
- `brain/scripts/scan-vault.js`: `withReport('embed-vault', …)` with `r.disable('no-embed')` at `:468-470` is the stage shape to copy.
- `brain/scripts/sdk/mcp-server.js`: 12 `registerTool` blocks (`:48-249`), `READ_ONLY` `:38`, and the header tool list `:8-20`.
- `brain/scripts/sdk/lib/claude-cli.js`: `buildArgs` `:65-71` (the lean flags) and `headlessEnv` `:74-77` (`AOS_HEADLESS=1`). The shim reuses both.
- `brain/scripts/sdk/lib/spend-ledger.js`: `recordSpend`, `spendToday({include, exclude})`, and `HOOK_EXCLUDE = /^(duty|reason|routine):/` `:57`.
- `brain/scripts/lib/detach.js` `respawnDetached` `:19`.
- `plugin/.mcp.json` declares only `agenticos`. That is pinned by `cli/plugin-manifests.test.js:61-64` and mirrored by `tools/build-codex-plugin.js`.
- The plugin has 17 commands and 6 skills (`cli/plugin-commands.test.js:7-13`, `tools/build-codex-plugin.js:94`, `README.md:103,417-418`).
- `vault-template/_gitignore` has no `graphify-out/` line.

## 4. Design

### 4.1 Install (`cli/aos.js`, new `cli/graph-cmd.js`)
- `uvBin()` follows the `ollamaBin()` shape (`AOS_UV_BIN`, then `which('uv')`).
- The init preflight fails with `uv not found — install it (docs.astral.sh/uv), then re-run aos init`.
- Step 5c, `graphCmd.install(ctx)`:
  - run `uv tool install --python '>=3.10' 'graphifyy==<pin>'` with the `UV_TOOL_*` env;
  - check `<bin> --version` equals `graphify <pin>`, then record `graph.bin`;
  - write `.graphifyignore` if absent: `workspaces/`, `brain/scripts/`, `brain/_index/`, `brain/graphify-out/`, `brain/archive/`, `templates/`, `.obsidian/`;
  - start the first structural build detached.
- `aos upgrade` reinstalls when the version is not the pin, and seeds `.graphifyignore` only if absent. Because upgrade never re-seeds `.gitignore`, `install` appends any missing `brain/graphify-out/` and `brain/graphify-out.pre-aos/` rule to an existing one (it never rewrites or creates the file), so a vault that auto-commits never commits the graph.
- An existing `brain/graphify-out/` without our marker (`.aos-graph.json`) is renamed once to `graphify-out.pre-aos/`, never deleted. It was built from some other root (D8).

### 4.2 Config
```json
"graph": { "enabled": true, "out": "brain/graphify-out", "timeoutSec": 120, "staleDays": 7,
  "semantic": { "enabled": "auto", "everyHours": 24, "perCallUsd": 0.25, "perDayUsd": 1, "tokenBudget": 20000, "timeoutSec": 1800 } }
```
`agenticos.json` gains `graph.enabled` and `graph.bin` (`buildUserConfig`).

### 4.3 CLI verb `aos graph`
| Command | Does |
|---|---|
| `aos graph` / `aos graph status` | Pin vs installed version, last structural and semantic runs, counts, top hubs, today's `graph:` spend against the cap, and whether the last semantic run was partial. |
| `aos graph build [--semantic] [--yes]` | Foreground run under the same lock. `--semantic` prints the pending note count and today's spend, then asks y/N (`--yes` skips). The shim's caps still apply. |
| `aos graph on\|off` · `aos graph semantic on\|off\|auto` | Toggle `graph.enabled` / set `graph.semantic.enabled`. |

The verb is wired in four places: the `plugin/bin/aos` case line, the `main` switch, `USAGE` and `BOOL_FLAGS`.

### 4.4 Worker (`brain/scripts/graph-build.js`) and stage
- The `scan-vault` stage `withReport('graph-build')` calls `disable('graph off' | 'graphify missing')`, or `respawnDetached` runs the worker.
- The worker:
  1. takes `brain/_index/.graph.lock` without blocking (it exits if the lock is held);
  2. copies `graph.json` to `.prev`;
  3. runs `update <vault>` with `GRAPHIFY_OUT` and `GRAPHIFY_NO_BACKUP=1`;
  4. on "Cannot read … for incremental merge", deletes `graph.json` and runs `update` once more (spike I: `--force` does not bypass it);
  5. writes the marker atomically.
- The semantic gates are:
  - enabled per D11;
  - due per `everyHours`;
  - today's `graph:` spend under the cap.

  If all hold, the worker runs `extract <vault> --backend claude-cli --token-budget N --allow-partial`. The child env has the shim dir first on PATH, plus `GRAPHIFY_CLAUDE_CLI_MODEL`, `GRAPHIFY_MAX_RETRY_DEPTH=0` and `GRAPHIFY_NO_BACKUP=1`, and it drops `*_API_KEY` and cloud credential vars so graphify's API-key auto-detect can never engage. The worker then stamps `lastSemantic`. A failed gate becomes a `disable()` reason in the `graph-semantic` report.
- The HUD's `PIPELINES_MANIFEST` gains `graph-build` and `graph-semantic`.

### 4.5 Shim (`brain/scripts/bin/graph-shim/claude` → `brain/scripts/graph-claude.js`)
- `--help` passes straight through, because graphify probes it for `--json-schema` support.
- Otherwise the shim:
  1. exits 1 if `spendToday({include: /^graph:/, exclude: null}) >= perDayUsd`;
  2. appends the D6 flags to graphify's argv (`-p --output-format json --no-session-persistence --json-schema …`);
  3. spawns `claude.bin` with stdin piped and stdout passed through byte for byte;
  4. parses the envelope and calls `recordSpend({feature: 'graph:semantic', …})`.
- A non-JSON stdout is passed through with no ledger row, and the shim's exit code mirrors the child's.

### 4.6 MCP tools (`sdk/lib/graph.js` + four `registerTool` blocks)
`lib/graph.js` does the following:
- loads `graph.json` (networkx node-link) and caches it by mtime;
- builds an undirected adjacency map;
- resolves a name by id, then title or vault-relative path (exact, case-folded, normalized, then shortest containing title). A title beats a path, and on a path the note's page node beats its headings, which share its `source_file`.

| Tool | Returns |
|---|---|
| `graph_query {q, depth≤3, budget}` | Seed nodes matching `q`, then BFS; nodes and edges with `source_file`, `relation` and `confidence`. |
| `graph_neighbors {node, relation?}` | The node's neighbours. |
| `graph_path {from, to}` | The shortest path. |
| `graph_overview {}` | Counts, hubs, communities, and the built-at time and mode. |

- Every tool is `READ_ONLY`.
- Output is capped at 50 KB and marked truncated past the cap. A missing graph gets a friendly "run `aos graph build`".
- Labels are note text, returned as data only.

### 4.7 Spike results (0.9.66, isolated tool dir, vault copy of ~330 in-scope notes / 1 MB)
| Check | Result |
|---|---|
| Install | Exit 0 in 1.2 s (warm cache); 134 MB; uv picked CPython 3.13 |
| `update` (A–C) | 1.4 s; about 2.7k nodes, 2.5k edges, 280 communities; `graph.json` 2.2 MB. Nothing written into the vault. Both ignore files honoured. A no-op run is byte-identical; one new link appears in 1.5 s. |
| Shrink guard (D) | Blocks only failed extraction, not deletions; a first run cannot be blocked |
| `update` after `extract` (F) | 60/60 semantic nodes, 38/38 edges and 4/4 hyperedges preserved |
| `ollama` backend (E) | Fails on a default Ollama (4096 context over `/v1`, thinking on). The workaround ran about 54 s per note. |
| `claude-cli` + shim (G) | 3-note fixture: 2.2k in / 1.2k out, 0 thinking, 10.7 s, $0.008. Without `MAX_THINKING_TOKENS=0`: 10.9k thinking tokens, $0.069. |
| Budget levers (H) | No USD cap, file cap or dry-run upstream. `MAX_RETRY_DEPTH=0` gives one call per chunk. |
| Estimate (pre-build) | First semantic pass about $1 at Haiku list price (extrapolated from 250k corpus tokens); daily increments cost cents |
| Measured (slice 3, 30 real notes, real graphify + shim + Haiku) | First run: 2 calls, $0.21, 222 s, one chunk failed → partial. Next run re-sent only that chunk: 1 call, $0.018, 24 s → complete, 14 concepts. Total ≈ $0.008 per note, output-heavy (≈ 0.45 out/in), so a ~330-note vault's first pass is ≈ $2.5 and drains over about 3 days under the $1/day cap. |
| D12 (a hook-shaped Haiku summary call) | Thinking on: $0.0027, 384 out (268 thinking), 4.7 s. Off: $0.0013, 108 out, 2.2 s. |

## 5. Testing
- **Fixtures:**
  - `cli/fixtures/fake-uv.sh` records its args and drops a `graphify` shim.
  - `cli/fixtures/fake-graphify.sh` copies a fixture `graph.json` into `$GRAPHIFY_OUT`.
  - A fake `claude` prints a fixture envelope.
  - No network anywhere.
- **`cli/aos.test.js`:**
  - `AOS_UV_BIN=''` makes init exit 1, with nothing written;
  - the doctor rows;
  - upgrade reinstalls on a pin drift;
  - an unmarked `graphify-out/` is moved aside.
- **`cli/graph-cmd.test.js`:** the toggles, `status` on a fixture, the `--semantic` y/N.
- **`brain/scripts/test/graph.test.js`:**
  - name resolution;
  - BFS depth and budget;
  - the shortest path;
  - the 50 KB cap;
  - a missing or corrupt graph;
  - the mtime cache.

  The fixture uses relative `source_file`s only.
- **`test/graph-build.test.js`:**
  - the lock;
  - `.prev`;
  - recovery from a corrupt graph;
  - each semantic gate's reason;
  - that the child env drops API keys and puts the shim first;
  - the timeout kill.
- **`test/graph-claude.test.js`:**
  - `--help` passthrough;
  - the appended flags and forced model;
  - `MAX_THINKING_TOKENS=0` and `AOS_HEADLESS=1` in the env;
  - a capped run exits 1 without spawning;
  - the ledger row from the envelope;
  - stdout passed through verbatim.
- **Other:** `graph:` rows sit outside the hook cap; the manifest and count tests (7 skills); `cli/rehearsal/first-run.sh` with `AOS_UV_BIN` pointing at the fake.

## 6. Rollout
Three PRs, each green on its own:
1. install, pin, doctor, the worker's structural pass, `aos graph` and the snapshot fix;
2. the MCP tools and the `graph` skill;
3. the semantic pass: shim, gates, the `graph:` family, and the doctor/status rows.

## 7. Out of scope
- Semantic extraction through Ollama. It needs upstream to honour the context size over `/v1` and to allow turning thinking off, or a vault-local provider file.
- Listing or quarantining notes whose extraction always returns nothing. The marker records only that a run was partial (`semanticIncomplete`); each such note costs one small call per due run, inside the cap.
- Graph neighbours as a `recall` RRF leg.
- A graphify layer in the HUD graph mode.
- `graphify export obsidian`.
- Per-workspace code graphs.
- Windows.
