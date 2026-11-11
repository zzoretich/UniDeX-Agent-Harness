# Codex terminals name their own conversation (code-chat R75)

Status: approved 2026-11-10 (new hook, D1); D3 revised and D7–D10 added after the code review and the live check · follows `2026-11-09-code-chat-design.md` (C2a) · target 2.6.0

## Problem

Code's chat follows a Codex terminal by guessing which rollout in its folder is its own (R17): Codex can't be started
with a session id, so the follower matches rollouts by folder and start time. Two Codex terminals opened in one
workspace within 5 s of each other can't be told apart, and both chats show "Can't tell which conversation · Terminal
⌘J" until one is closed (R75, a known limitation of PR #195). The same guess also misses a Codex started from the
terminal's shell in another folder.

## Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | **A Codex SessionStart hook, `code-session`, records the terminal's session.** When `AOS_TERMINAL` is set (each Code terminal's key, code-chat C2a) it writes `brain/_index/code/<terminal>.session.json`: `{ at, host, session_id, source }`. It prints nothing (a Codex SessionStart hook's stdout becomes model context) and exits 0 on every path. | Folding the write into `telemetry-hook` or `reconcile-sessions`, which saves Codex users the one-time trust: telemetry can be turned off, and reconcile runs at most once per 5 minutes, so the claim would silently stop working. Dropping a follower out of contention when its agent ends (R75's other option): it fixes only the closing case, not two live terminals. |
| D2 | **Codex only.** Claude Code is launched with `--session-id`, and the status-line tee already names each session change, so its follower never guesses. | The same hook for Claude: a third source that says nothing new. |
| D3 | **The report wins once, and the guess stays as the fallback.** The folder-mode follower acts on each new report once. Its claim names the reported session at once, so no peer takes that rollout, but the chat stays on what it shows. The follower looks the rollout up by id (`findTranscript`) and follows it once it exists and is an interactive one (R26). Until then it skips the folder guess (so no "Can't tell" while it waits). After that, the guess goes on as before, so `/resume` in the TUI and a Codex with the hook untrusted still behave as in 2.6.0's PR 4. | Following the report whenever it names a session other than the current one: when the guess correctly moves to a resumed rollout and no new report comes, the follower would flip back to the old session. Emptying the chat as soon as the report arrives (review C1, I1): a report that turns out not to be the terminal's own would have cleared a live chat and released its rollout. |
| D7 | **A report that isn't the terminal's own conversation is dropped** (review I1). Any Codex started inside a Code terminal inherits `AOS_TERMINAL`, including a `codex exec` the agent runs through its shell. The follower drops a report when its rollout is not interactive, or when the conversation the chat shows gets a new prompt while the report waits. The second case covers an exec that writes no rollout, and a session left before its first prompt. | A hook-side check of `CODEX_THREAD_ID` (a nested Codex inherits its parent's): unverified for hook commands, and if wrong it would silently turn the hook off. |
| D8 | **A follower's claim keeps the rollouts it followed before** (`held`, the last 20), and peers treat them as claimed (review C1). When a terminal moves on (a `/new`, a `/resume`), a quiet neighbour must not adopt its old rollout. That already could happen in PR 4's guess path. | Releasing a rollout on a move: the neighbour's guess sees an older rollout appended after its own last append and takes it. |
| D9 | **A closed terminal's rollouts stay claimed until one grows again** (found in re-review; PR 4 had it too). When a follower stops, it writes `<terminal>.closed.json` (`{ cwd, held, closedAt }`). Peers skip those rollouts unless one was appended after the close, which means it was resumed somewhere. Pruned after 14 days. | Leaving it to the claim: the claim goes with the follower, and a quiet neighbour's guess takes the closed terminal's last conversation. |
| D10 | **"Can't tell" waits for three ambiguous scans in a row** (4–6 s; seen in the live check). Codex writes a rollout at the first prompt and runs the hook a moment later, so a neighbour's 2 s guess can find the rollout unclaimed in between. | Writing it at the first ambiguous scan: the error row stays in a chat that follows its own conversation fine. |
| D4 | **A report counts only if it is from this terminal's life.** Its `at` must be no earlier than 1 s before the terminal started (`--since`). For a follower started with an id (Resume, chip restart), it must also be no earlier than 1 s before that follower started, so an older report can't override that id. | Trusting any report: a replaced follower would jump to the session the previous run reported. |
| D5 | **The rollout is found by id, never by the report's path.** `transcript_path` is ignored, so a report can only point at a file in Codex's own sessions folders. | Reading `transcript_path`: then any file named in the vault would get copied into the chat cache. |
| D6 | **Reports are pruned like claims** (14 days, by `pruneCodeCaches`). The follower leaves the report alone when it stops, because it didn't write it. | Removing it when the follower stops: a replaced follower would delete the report its successor needs. |

## What already exists (main at e3aca80)

- `brain/scripts/lib/code-mirror.js` `follow()`: folder mode for Codex (R17/R18), claims `<terminal>.claim.json`,
  `pickCodexRollout` with the 5 s same-start rule (`SAME_START_MS`), and the ambiguous message. `start(file, id)` adopts a
  rollout and writes the claim, so peers stop contending as soon as one follower adopts.
- `app/src/main/services/pty.ts` sets `AOS_TERMINAL` on every agent PTY. `code-mirror.ts` starts the follower when the
  terminal is created (`codeFeeds.ts`), so it is running before Codex's SessionStart fires.
- Codex 0.167's `session-start.command.input`: `session_id`, `transcript_path` (nullable), `cwd`, `source` (startup,
  resume, clear, compact, fork), `model`, `permission_mode`. Hooks run as `env AOS_HOST=codex … aos <verb>` (`HOOKS` in
  `cli/codex-host.js`).
- Precedent for a Codex-only SessionStart hook: `inject-conventions`.
- Seen in the live check (codex-cli 0.167.0, the dev app, 2026-11-10): the hook receives `AOS_TERMINAL`; Codex fires
  SessionStart at a conversation's first prompt, when it writes the rollout, not when the TUI opens; after `/new` (and its
  "where should it run" choice) the next prompt fires it again with `source: "startup"`.

## Design

- `brain/scripts/code-session.js` (new): reads the payload from stdin. If `AOS_TERMINAL` is a v4 uuid and `session_id`
  is a valid id, it writes the report atomically (`writeAtomic`) with `host` from `lib/host.js` `currentHost`. It is
  reached as `aos code-session` (an arm in `plugin/bin/aos`), and listed in `HOOKS` under SessionStart with a 10 s
  timeout. The build regenerates `codex-plugin/`, and direct wiring gets the same entry.
- `code-mirror.js`:
  - Each poll in folder mode stats `<terminal>.session.json` and reads it again only when its inode or mtime changed. A
    report passes when it is valid, has `host === 'codex'` and is not yet acted on (key `at|session_id`), and D4 holds.
    A report naming the session the chat shows is just marked acted on, as on a Resume or a chip restart. Any other report
    that passes is held as pending: the claim's `session` names it, and the turn count is noted.
  - Each scan resolves the pending report. It looks up the id and reads the rollout's meta: an interactive rollout is
    followed (`start(file, id)`), and a non-interactive one is dropped (D7). While a report is pending, `scanCodex` does
    not run the folder guess. A new prompt in the current conversation drops it (D7).
  - Claims carry `session` and `held` (D8); `pickCodexRollout` treats both as claimed. A no-file peer that waits for a
    reported session neither contends (R25) nor counts for the 5 s rule.
  - `pruneCodeCaches` also sweeps `.session.json`.
- Docs: the module header (the "Codex:" paragraph), `docs/app-smoke.md` TM11 adds the two-terminal step, CHANGELOG Fixed
  plus **Upgrading** (trust the new hook once), and the R75 note in COVERAGE.md if one exists.

Tests (`brain/scripts/test/`): the hook writes nothing without `AOS_TERMINAL`, writes the report with it, and prints
nothing. The follower covers:
- two followers in one folder, both started within 5 s, each with its own report: each follows its own rollout and no
  "Can't tell" is written;
- a report that arrives before its rollout exists: no guess while it waits, then adoption;
- an old report: ignored by a follower started with an id;
- a guess that moves to a resumed rollout after the report: no flip back;
- the report's `transcript_path` pointing elsewhere: ignored;
- a `/new` in one of two resolved terminals while the other is quiet: the other keeps its own (D8);
- a nested exec's report, with a non-interactive rollout or none: dropped (D7);
- a report naming the session a follower given an id already shows: the transcript is not read again;
- a terminal with no report beside one whose report is pending: it neither takes the reported rollout nor says
  "Can't tell".

## Host parity

1. Host detection: through `lib/host.js` only. 2. Hooks: one new Codex SessionStart command, so Codex users trust it
   once. 3. Sessions: Codex rollouts, read through `findTranscript`. 4. No model call. 5. No new config key.
   6. The HUD and app don't change. 7. The known gaps are unchanged.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Code: new terminal | unchanged: `--session-id` + the status-line tee | — |
| Codex only (plugin · direct) | Code: new terminal | `code-session` writes the terminal's session at each SessionStart; the follower adopts it | hook not yet trusted, or Codex before hooks: the folder guess, as in PR 4 ("Can't tell" for two terminals started together) |
| Both | as each host above | as each host above | as each host above |

## Out of scope

Rollouts claimed across folders (a Codex started in another folder is followed via its report, but other folders'
followers don't see that claim). The HUD's chat rendering. Claude Code's follower.
A report that never resolves and never sees a new prompt in the current conversation keeps the folder guess off until the
next report (review M3). This happens with a Codex that reports and then quits before its first prompt, followed in the
same terminal by an agent that doesn't report (another `CODEX_HOME` with the hook untrusted). It is rare, and costs only
the guess for what no report names.
