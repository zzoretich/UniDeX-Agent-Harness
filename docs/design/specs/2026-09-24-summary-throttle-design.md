# Session summary throttle — design

Date: 2026-09-24 · Branch: `feat/summary-throttle` · Verified against `d400764` (v0.19.2 + #53, #54), Claude Code 2.1.281, codex-cli 0.156.1

Review finding R4, the second of the four P3 PRs.

## 1. Problem

The Stop hook (`update-session.js`) spawns a working-memory summary (BRAIN.md Last Session, the daily note,
SESSION.md) "every 5 user turns". Two bugs:

- **What counts.** `parseClaude` counts every user-role entry, and Claude Code writes each tool result and each
  slash-command envelope as one. A real transcript had 43 such entries for 2 prompts, so a busy session summarized
  every few minutes (13 summaries at 1–12 minute gaps on 2026-09-23). Codex's counting was already close: its injected
  envelopes are skipped and tool output is not a user message.
- **Whose count.** The marker is `.last-summary-<date>`, one number per day shared by every session. After one busy
  session the marker read 306, so the next session of the day (141 entries in) could not summarize until it passed 311.

`readStdinAndRun` was not exported, so nothing tested the throttle, and `transcript.test.js` pinned `userTurns === 3`
for a fixture with one real prompt.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Count prompts.** `isRealPrompt(turn)` in `lib/transcript.js`: a user turn with text that is not Claude's `isMeta`, a slash-command envelope (`<command-name`, `<command-message`, `<command-args`, `<local-command…`) or a tool result (flattens to blank). Both parsers return `prompts` next to `userTurns`. | Redefine `userTurns`. | `inject-context.js` reads `userTurns > 0` and the field is documented; a second field changes nothing else. |
| D2 | **One marker per session**: `.last-summary-<session_id>` (both hosts send `session_id` to the Stop hook), holding `{ prompts, at }`. A payload without one falls back to the day. An old bare-number marker starts over. | Keep a daily marker keyed by session inside one file. | One small file per session needs no lock and cannot starve another session. |
| D3 | **Every 10 prompts, at least 15 minutes apart** (owner's choice, 2026-09-24): `summary.everyPrompts` (10) and `summary.minMinutes` (15; 0 = no floor) in `config.default.json`, pickers in ⚙ Settings → Memory & scanning. | 5 prompts with a 10-minute floor; 5 with no floor. | The owner picked fewer summaries: cheaper under the Claude provider, and Last Session still refreshes during a working hour. |
| D4 | **A pure `shouldSummarize({ prompts, last, now, everyPrompts, minMinutes })`**, exported with `summaryMarkerName`, `parseSummaryMarker` and `summaryPolicy`. A count below the marker's (a transcript that started over) counts from zero. | Test through a spawned hook. | The rule is the part that was wrong; testing it needs no process or clock. |
| D5 | **`applies: 'next-reply'`** for both settings, with the HUD label "applies from the next reply". | `next-call` ("next model call"). | The hook re-reads the config on every Stop; the existing labels would mislead. |

## 3. What already exists (at `d400764`)

- `brain/scripts/update-session.js` `readStdinAndRun` (`:101-130`), `lib/markers.js` `markerPath` (sanitizes names).
- `lib/transcript.js` `parseClaude` / `parseCodex`; the same prompt filter inline in `update-session.js`
  `conversationTail` and `lib/heuristics.js` (left as they are: they filter both roles, or collect command names).
- `inject-context.js` keys its own marker by `session_id` already (`.injected-<sid>`).

## 4. Host parity

1. **Entry point.** The Stop hook on both hosts; no command.
2. **Hooks.** The hook command is unchanged; Codex users re-trust nothing.
3. **Model calls.** The summary still goes through `provider.js`; only when it runs changes.
4. **Session data.** Transcripts through `lib/transcript.js` for both formats; `prompts` is fixture-tested on each.
5. **MCP.** None.
6. **Degradation.** No `session_id` → the day's marker, as before, with the new counting.
7. **Docs.** CHANGELOG; the settings carry their own help.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | the Stop hook | `update-session.js`, prompts from `parseClaude` | — |
| Codex only (plugin · direct) | the Stop hook | the same, prompts from `parseCodex` | — |
| Both | either | one marker per session, whichever host | — |

## 5. Out of scope

The summary's lost-update race on BRAIN.md and SESSION.md (review R2, the fourth P3 PR); pruning old markers (they
live under the OS temp dir).
