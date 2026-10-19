# MCP read tools: index first — design

Date: 2026-09-24 · Branch: `feat/feedback-rules-index` · Verified against `5166f79` (v0.19.2 + #53), Claude Code 2.1.281, codex-cli 0.156.1

Review finding M5, the first of the P3 fixes ("stop the brain breaking silently"): the owner approved the split into four
PRs (M5 → R4 → R3 → R2) on 2026-09-24.

## 1. Problem

- `feedback_rules` returns every rule's full file as pretty-printed JSON, and `listFeedback()` walks
  `brain/memory/feedback/**`, so the correction detector's unreviewed `_drafts/` come back as rules. On a real vault
  (70 rules + 8 drafts) one call was 78.5 KB, about 20k tokens, and the description promised "every active" rule.
- `memory_list` returns every memory with its whole frontmatter (102 KB on the same vault); `session_recall` returns a
  daily note of any length (40 KB seen).
- `jsonResult` indents every result, about 15% of the text a model reads.
- No test pinned the output of any of the three tools.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **`feedback_rules` returns an index by default**: `{ count, shown, rules: [{ path, title, description, updated }] }`, newest first. `full: true` adds each rule's `content`; `limit` keeps the N newest. `memory_read` reads one rule. | A new `feedback_index` tool next to the old one. | One tool name keeps both hosts' names (`mcp__plugin_agenticos_agenticos__feedback_rules`, `mcp__agenticos__feedback_rules`) and every doc reference; the one caller that needs the text asks for it. |
| D2 | **Drafts are left out**: a file in a `_`-prefixed folder under `brain/memory/<type>/` is a draft (`isDraftPath`). Applies to `feedback_rules` and `memory_list`. `listMemories()` itself is unchanged. | Filtering in `listMemories()`. | `consolidate-memory` and `ask` use `listMemories()` and were not part of the finding. |
| D3 | **Compact JSON for every tool.** | Compact only for the large tools. | Every result is read by a model; tests already `JSON.parse` the text. |
| D4 | **Title** is the file's H1 (else its `MEMORY.md` title, else the file name); **description** is its `MEMORY.md` line (curated), else its first body line without markdown emphasis, cut at 200 characters. | Frontmatter `description`. | Memory files carry no `description` key; the index lines are where the one-liners live. |
| D5 | **`memory_list`** returns the same cards grouped by type, with `type` and `limit` filters. **`session_recall`** cuts at `maxChars` (default 24,000, at most 200,000) and ends with a line giving the full length and how to ask for it. | A byte cap that halves arrays (`graph.fit`). | Nothing calls these two from a skill; a plain cap with an explicit way to read more keeps them honest. |
| D6 | **Callers:** `feedback-review` step 3 asks for `full: true` (it compares draft text against rule text); `cross-review` reads the index and then `memory_read` for the rules that bear on the plan. `codex-plugin/` is regenerated. | — | The index is enough to choose; the text is needed to compare. |

## 3. What already exists (at `5166f79`)

- `brain/scripts/sdk/lib/brain.js`: `listMemories`, `listFeedback`, `parseFrontmatter`, `readSession`.
- `brain/scripts/sdk/mcp-server.js`: `jsonResult`, the three tools; `snapshot_read`'s `full` flag and `recall`'s `limit`
  are the precedents.
- `brain/scripts/test/wrap-session-tool.test.js`: the MCP client harness over stdio.

## 4. Host parity

1. **Entry point.** The same MCP server for both hosts; tool names and arguments are the same.
2. **Hooks.** None.
3. **Model calls.** None.
4. **Session data.** Daily notes only (`session_recall`), as before.
5. **MCP.** No new tool; three tools gain optional arguments, so an older caller keeps working and gets the index.
6. **Degradation.** None host-specific.
7. **Docs.** The two skills (and their generated Codex copies); CHANGELOG.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | `mcp__plugin_agenticos_agenticos__feedback_rules` (from `feedback-review`, `cross-review`, a session) | `sdk/mcp-server.js` | — |
| Codex only (plugin · direct) | `mcp__agenticos__feedback_rules` | the same server | — |
| Both | either | the same server | — |

## 5. Out of scope

`memory_search` snippets, `pattern_list` frontmatter, and a whole-injection budget (review M4).
