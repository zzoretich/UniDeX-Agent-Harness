---
name: wrap
description: In-session memory extraction at the end of a Claude Code session — review the conversation, then call the wrap_session tool once so memories, MEMORY.md lines, SESSION.md sections and feedback drafts are written through the same writer the background auto-wrap uses. Use during /wrap, when SESSION.md shows "not wrapped — run /wrap", or when the user says "wrap up", "save what we learned", "close the session".
---

# Wrap — in-session extraction

The background `auto-wrap` hook extracts memories with the configured provider. When
there is no provider (or the user prefers it), this skill does the same extraction in
the session and hands the result to the one vault write tool of the `agenticos` MCP server:
`wrap_session` (`mcp__plugin_agenticos_agenticos__wrap_session`). Everything downstream — noise gate,
memory writer, `MEMORY.md` index line, promote trail, `SESSION.md` sections, feedback
drafts — is identical to the hook path.

## Steps

1. Skim the whole conversation once. Ignore tool noise; keep what a future session would need.
2. Build the extraction:
   - `facts`: durable statements learned this session (paths, versions, how a thing works). ≤ 8, one sentence each.
   - `decisions`: choices made and why. ≤ 5.
   - `feedback`: how the user wants you to work, in their words. ≤ 5.
   - `threads`: open items and next steps. ≤ 5.
   - `candidates`: memories worth a file. ≤ 3, each `{ type, title, description, body }` with `type` ∈ `user | feedback | projects | reference`, `title` ≤ 60 chars, `description` ≤ 90 chars, `body` at least three sentences of self-contained markdown. No secrets, no tokens, no credentials, nothing the user marked private. (These caps are the same ones the background `auto-wrap` prompt and the `wrap_session` schema state.)
   - `corrections`: every place the user corrected you: `{ quote, rule, why }` (`quote` verbatim, `rule` as an imperative, `why` one line). These become drafts under `brain/memory/feedback/_drafts/` for the `feedback-review` skill, never live rules.
3. Call `wrap_session` **once** with that object (add `sessionId` when the injected context shows it).
4. Read the result `{ written, skipped, reasons, drafts }`. Report one line: `wrap_session: N written, M skipped (reasons…), K drafts`. A skip with reason "duplicate title" or "junk summary" is the noise gate doing its job — do not retry with a reworded candidate.
5. Then continue the `/wrap` command's remaining steps (daily-note summary, BRAIN.md `## Last Session`).

## Boundaries

- Never write memory files or `MEMORY.md` lines directly during a wrap; the tool keeps the index and the trail consistent.
- Never call `wrap_session` twice for the same session; a second call duplicates `SESSION.md` sections.
- Do not turn a `feedback` line into a `candidates` entry of type `feedback` unless the user explicitly asked for a permanent rule — corrections go through `corrections` and the review skill.
