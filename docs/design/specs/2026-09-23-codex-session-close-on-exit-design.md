# Close Codex sessions when the Codex process exits — design

Date: 2026-09-23 · Branch: `feat/codex-session-close-on-exit` · Verified against `7bf3c08` (v0.15.0) · From the
approved persona proposal `codex-session-close-on-exit` (filed 2026-09-23)

## 1. Problem

Quitting the Codex 0.156.1 TUI fires no SessionEnd for the session's own thread (the log shows a shutdown only for a
side thread). The live run header stays under `brain/_index/agent-runs/live/` until `reconcile-sessions` finds it idle
for `telemetry.staleAfterMinutes` (30), so the `runs.jsonl` row, auto-cost and auto-wrap of every Codex TUI session
arrive about half an hour late. The header's `pid` is the hook's own short-lived node process, and
`reconcile-sessions.js` decides on idle time alone.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | **Record the Codex process in the live header.** When `ensureHeader` creates a `host: codex` header it adds `host_pid` and `host_started` (ISO): the outermost ancestor of the hook whose command basename is exactly `codex` (D3), and its start time. Both `null` when none is found. | A shorter Codex-only `staleAfterMinutes`. | An open but idle session would be finalized while the user is away; its next turn would open a second run for the same session id (two rows, two wraps). |
| D2 | **One process-table read.** `ps -A -o pid=,ppid=,lstart=,comm=` under `LC_ALL=C`, parsed once and walked in memory (at most 32 hops). | One `ps -p` per ancestor. | One spawn (~20 ms for ~400 processes) instead of four or five; `LC_ALL=C` fixes the `lstart` format, which both the hook and the sweep parse. |
| D3 | **Exact basename match, outermost wins.** `path.basename(comm) === 'codex'`, and the walk keeps the outermost match. | Substring match on `codex`; the nearest match. | macOS `comm` is the full path; a long-lived helper under `~/.codex/plugins/…` contains `codex` and would pin the rule to a process that never exits. Linux `comm` is already the basename. A short-lived helper re-exec'd under the same name, if a hook ever ran below one, would exit after the hook and end a live session; the outermost match can only err towards a longer-lived process, which falls back to the idle rule. |
| D4 | **Gone = dead or reused.** A header's Codex process is *gone* when `kill(pid, 0)` fails with `ESRCH` or `EPERM` (not ours, so not our Codex), or when the pid's current start time differs from `host_started`. *Alive* otherwise. A header without `host_pid`, or with an unreadable start time, is *unknown*. | Compare only liveness. | pid reuse would keep a closed session live; the start time settles it. Unknown never finalizes early. |
| D5 | **Gone skips the idle window, nothing else changes.** `findStale` returns a `host: codex` run whose process is gone whatever `staleAfterMinutes` says; `endRun(id, 'reconciled')` with `ended_at` = the later of the transcript's and the live file's last change, then auto-cost and auto-wrap, exactly as today. Alive and unknown keep the idle rule. | A new `end_reason`. | The HUD, costing and wrap already treat `reconciled`; an idle-rule fallback keeps the desktop app and the shared app-server daemon (whose process outlives the thread) on today's behaviour. |
| D6 | **Codex only.** Claude Code runs are left as they are. | Record `host_pid` for both hosts. | Claude Code fires SessionEnd on a normal exit. Under a pty-hosted Claude Code session the hook's ancestor is a long-lived `claude bg-spare` process started a day earlier (checked 2026-09-23), so the rule would rarely fire there and could name a reused process. |

## 3. What already exists (at `7bf3c08`)

- `brain/scripts/telemetry-hook.js:70-87` `ensureHeader` (writes `pid: process.pid`, `host` from `currentHost`).
- `brain/scripts/reconcile-sessions.js:43-63` `findStale` (idle rule on header, live file and transcript mtimes);
  `:72-88` `reconcile` (endRun → auto-cost → auto-wrap, `AOS_HOST` from the header); the 5-minute sweep stamp.
- The sweep runs on SessionStart and Stop of both hosts (`plugin/hooks/hooks.json`, `HOOKS` in `cli/codex-host.js`).

## 4. Design

- New `brain/scripts/lib/host-process.js` (no deps):
  - `processTable({ run })` → `Map<pid, { ppid, started, comm }>` from the D2 call; `null` when `ps` fails.
  - `findHostProcess(binary, { pid = process.pid, table })` → `{ pid, started }` or `null` (D3 walk from `pid`, outermost match).
  - `hostProcessState({ host_pid, host_started }, { kill, startedOf })` → `'alive' | 'gone' | 'unknown'` (D4);
    `startedOf(pid)` reads one `ps -o lstart= -p <pid>` under `LC_ALL=C`.
  - `parseLstart(s)` → ISO or `null`.
- `telemetry-hook.js` `ensureHeader`: for `host === 'codex'` only, `host_pid` / `host_started` from
  `findHostProcess('codex')` inside a try (any failure → `null`, the hook never fails).
- `reconcile-sessions.js` `findStale`: before the idle checks, a `host: codex` header with a `host_pid` whose state is
  `gone` is pushed at once (deps take a `processState` seam for tests). Header comment updated.
- Docs: `docs/install.md` "What differs from Claude Code", `docs/plugin-smoke.md` (the Codex TUI check).

Tests: `test/host-process.test.js` (table parse with a path containing spaces and a decoy `…/.codex/…` helper; walk
finds the outermost `codex` ancestor and ignores the decoy; `lstart` parse; state: a real child process alive → killed → gone;
a changed start time → gone; no pid → unknown). `test/reconcile-sessions.test.js`: a gone Codex run inside the idle
window is reconciled; an alive one is not; a header without `host_pid` keeps the 30-minute rule; a Claude header with a
`host_pid` is ignored. `test/telemetry-hook.test.js`: a hook run under a process named `codex` (a symlink to node) records that
process's pid and start time; outside Codex both keys are null; a claude header carries neither.

## 5. Host parity

1. **Entry point.** None new. The sweep already runs on SessionStart and Stop of both hosts.
2. **Hooks.** No hook command changes, so Codex users re-trust nothing.
3. **Model calls.** None.
4. **Session data.** Reads the live header it already reads, plus the OS process table; transcripts through
   `host.findTranscript` as today.
5. **MCP.** No new tool.
6. **Degradation.** No Codex ancestor, no `ps`, or a long-lived Codex process → `unknown`/`alive` → the 30-minute
   rule, i.e. today's behaviour.
7. **Docs.** `docs/install.md`, `docs/plugin-smoke.md`; no counts change.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | nothing new | unchanged (SessionEnd, or the idle reconcile for a killed terminal) | — |
| Codex only (plugin · direct) | quit the TUI | the next sweep (next SessionStart/Stop of either host, ≤ 1 per 5 min) finalizes the run: row, cost, wrap | no Codex ancestor found → the 30-minute rule, as today |
| Both | quit a Codex TUI, keep working in Claude Code | Claude Code's next Stop runs the sweep and finalizes the Codex run | as above |

## 6. Out of scope

- Running the sweep between sessions (the proposal's item 4, a heartbeat routine calling `aos reconcile-sessions`).
- The same rule for Claude Code runs (D6).
