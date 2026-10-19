# No duplicate sessions, no double wraps — design

Date: 2026-09-24 · Branch: `feat/no-duplicate-sessions` · Verified against `fa6dc72` (v0.19.2 + #53–#55), Claude Code 2.1.281, codex-cli 0.156.1

Review finding R3, the third of the four P3 PRs.

## 1. Problem

One session could become several runs, each wrapped and costed as if it were the whole session. On the owner's vault
(runs.jsonl since 2026-09-21): 7 sessions with more than one row (12 extra rows), 27 false "crashed" rows, one session
with three rows each carrying its full $50.77, and a promote log showing auto-wrap writing twice for one session.

- **The HUD's orphan sweep** (`hud/src/data/orphanSweep.ts`, on every Obsidian load) ended any live run
  whose header `pid` was dead and older than 5 minutes. That pid is the telemetry hook's own process, which exits at
  once, so every session idle for 5 minutes was ended as "crashed" (no `session_id`, no host, no cost, no wrap), and
  its next tool call opened a new header. This was most of the duplicates; the review missed it.
- **The idle reconcile** (`reconcile-sessions.js`, 30 minutes) ends a session the user merely left open; its next
  event opens a new header too. A resumed Claude session does the same.
- **auto-wrap** takes the last 50,000 characters of the whole transcript with no record of what it already wrapped,
  so every run of one session re-extracted the same text.
- **Timelines** are `<day>/<run id>.json` and every segment had the id `sess-<session id>`: a later segment on the
  same day overwrote the earlier one's timeline.
- **cost-sync** writes the whole session's cost into every row of the session.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **The HUD runs `reconcile-sessions.js` on load** (quietly, telemetry on only) and has no sweep of its own; `orphanSweep.ts` is deleted, so the plugin no longer appends to runs.jsonl. `AOS_HOST` / `CLAUDE_PROJECT_DIR` are blanked so it never takes the hook path. | Fix the HUD's pid check. | Two implementations of "is this run over" drifted apart once already; the runtime's rules (idle past `telemetry.staleAfterMinutes`, a Codex process that exited) end runs with a cost and a wrap, and keep the 5-minute stamp. |
| D2 | **No host-process liveness for Claude Code.** The reconcile keeps its rules. | Record the Claude host pid and never end a live one. | From a pty-hosted session the hook's ancestors are `claude bg-spare` → `claude bg-pty-host` → a `claude` daemon running since the day before (checked 2026-09-24); an exact match lands on the daemon, which is always alive. The close-on-exit spec's D6 found the same. |
| D3 | **A per-session wrap offset** (`lib/wrap-offsets.js`, `brain/_index/agent-runs/wrap-offsets.json`): auto-wrap extracts only the flattened transcript after the offset, skips with `already-wrapped` when that part has no user line (`no-transcript` when there is no text), and moves the offset after a pass that did not throw. Newest 500 sessions kept. | Key the ledger by session; wrap only on the last segment. | Every later wrap of a session (reconcile then SessionEnd, resume, a spooled retry) now adds only what is new; no pass can know it is the last. |
| D4 | **Continuation segments.** A header counts the session's closed rows in runs.jsonl: segment 2 onward gets run id `sess-<id>-s<n>` and `segment: n`, and the row carries `segment`. | Merge the rows into one. | A row is a closed run; rewriting runs.jsonl is what the fourth P3 PR (R2) removes. With its own id a segment's timeline is its own file, and `heartbeat-writer`'s link (built from the row id) points at it. |
| D5 | **Cost is left to R2.** cost-sync still costs the whole session into each of its rows; R2 moves costs to their own records, counted once per session. | Patch only the newest row here. | That would be another rewrite of runs.jsonl, the race R2 exists to end. |

## 3. What already exists (at `fa6dc72`)

- `telemetry-hook.js` `ensureHeader` / `endRun`; `reconcile-sessions.js` `findStale` / `reconcile` / `main` (direct run:
  synchronous, stamp-throttled); `lib/host-process.js` (Codex only, spec 2026-09-23-codex-session-close-on-exit).
- `auto-wrap.js` `extractOnce` (the one path for the live session and spooled retries), `runAutoWrap`,
  `loadTranscriptText` → `flattenTurns` (`role: text` lines).
- `hud/main.ts` `runBrainScript` (detached spawn, a notice per run).

## 4. Host parity

1. **Entry point.** Hooks (SessionStart, Stop, SessionEnd) on both hosts; the HUD on load. No command.
2. **Hooks.** Commands unchanged; Codex users re-trust nothing.
3. **Model calls.** auto-wrap's, through `provider.js` as before; fewer of them.
4. **Session data.** Transcripts through `lib/transcript.js` for both formats; the offset is per `session_id`.
5. **MCP.** None.
6. **Degradation.** An unreadable offset store means one full wrap, as before; telemetry off → the HUD runs nothing.
7. **Docs.** CHANGELOG; `docs/plugin-smoke.md` (the telemetry-off item).

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | hooks; Obsidian load | reconcile-sessions (idle rule), telemetry segments, auto-wrap offsets | — |
| Codex only (plugin · direct) | hooks; Obsidian load | the same, plus the Codex exited rule | — |
| Both | either | the same, per session | — |

## 5. Out of scope

Cost once per session and the runs.jsonl rewrite race (R2). The past rows on existing vaults stay as they are; R2's
readers count a session's cost once whatever rows it has. The in-session `/wrap` (`wrap_session`) does not move the
offset yet.
