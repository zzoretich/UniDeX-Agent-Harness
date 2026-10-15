#!/bin/sh
# run-duty.sh — run one Chief of Staff duty headlessly and enforce the duty contract
# (a new journal entry this run), with runner-side FAILED handling when the duty dies
# before reporting. POSIX sh: no arrays, no pipefail, no printf %q, no sed -i.
#
# usage: run-duty.sh <duty> [--dry-run]
# env:   AOS_CONFIG        agenticos.json (default <configDir>/agenticos.json)
#        AOS_VAULT         vault dir (default: "vault" in agenticos.json)
#        AOS_NODE          node binary (default: "node" in agenticos.json, then the bin/aos probe list)
#        PERSONA_MODEL     duty model on Claude (default: persona/chief.js — persona.model → the interview's dutyModel →
#                          claude.model → claude-opus-5-5; a Claude model by contract, never passed to Codex)
#        PERSONA_EFFORT    low|medium|high (default: persona.effort, else medium)
#        PERSONA_LOG_DIR   default <vault>/persona/journal/logs
#        PERSONA_TOOLS     --allowedTools value (write tools and git read-outs are dropped: the write scope decides writes)
#        PERSONA_WRITES    comma list of extra vault-relative paths the duty may write (a routine's `writes:`)
#        PERSONA_MAX_USD   --max-budget-usd for this run (default persona.perDutyUsd from config, else 2)
#        PERSONA_CLAUDE_BIN  claude binary (default: hosts.claude.bin / claude.bin from agenticos.json, then
#                          `command -v claude`, then the usual install locations — lib/headless.js resolveBin)   # (A24)
#        PERSONA_TIMEOUT   seconds, default 1800
# Host and model (local-first A4): persona/chief.js (lib/headless.js resolveChief) picks the host — persona.runner, auto →
# Claude when it is on and signed in, else Codex — and that host's CoS model (claude-opus-5-5 / gpt-6-sol on a 2.0 install),
# and moves the duty to the other host when the primary cannot start (CLI missing, signed out) while persona.failover is
# on. persona.perDayUsd is one cap over both hosts: a capped day is skipped everywhere, never moved. A skipped duty is not
# a failed one: one journal entry (SKIPPED daily-cap, or SKIPPED waiting-for-host plus one flag a day under ## Flags).
# Helper: two duties have a runner-side helper — tick.js for `tick`, reflect.js for `reflect-daily`: `precheck` exit 3 →
# the model call is skipped ("skipped:" in the log, no journal entry, exit 0); `beat` runs once the duty met its
# contract (the tick records its beat and may start an early reflect; the daily reflect drains the queue).
# Daily cap: record-spend.js --check compares today's duty:* ledger spend with persona.perDayUsd;
# a capped day journals "SKIPPED daily-cap" and exits 0 (hook spend never blocks a duty).
# Flags: --strict-mcp-config (no MCP servers) and --no-session-persistence (no session file) are always
# passed; --setting-sources "" is deliberately NOT passed — a duty may read the vault's CLAUDE.md and
# settings, unlike the brain's own claude -p recipe (sdk/lib/claude-cli.js).   # execution amendment 2026-09-15 (A25)
# Git: this runner never commits — the vault ignores persona/journal/ and persona/STATE.md.   # (A7)
# Write scope and guard (spec 2026-09-23-duty-write-scope-design): duty-guard.js builds what the host enforces before the
# run (Claude: dontAsk, absolute Edit rules, deny rules; Codex: persona/ as the workspace plus --add-dir folders),
# snapshots the persona trust files, and after the run restores any it changed — the run then ends FAILED.
set -u
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="${AOS_CONFIG:-$CONFIG_DIR/agenticos.json}"
# json_value <key>: first "key": "value" string in agenticos.json (flat scan; no jq) — only for vault and node, keys that
# occur once; the duty model comes from persona/chief.js.
json_value() {
  [ -f "$CONFIG" ] || return 0
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -n 1
}

VAULT="${AOS_VAULT:-$(json_value vault)}"
[ -n "$VAULT" ] || { echo "run-duty: no vault (set AOS_VAULT or run 'aos init')" >&2; exit 1; }
NODE="${AOS_NODE:-$(json_value node)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
  # Same probe list as bin/aos (contract §4.1); the nvm entry is an unquoted glob on purpose.
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node"; do
    [ -n "$NODE" ] && break
    [ -x "$c" ] && NODE="$c"
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  # execution amendment 2026-09-15 (A27): say so instead of silently skipping the cap check and the ledger below.
  echo "run-duty: node not found (set AOS_NODE or \"node\" in agenticos.json) — daily cap check and spend ledger skipped" >&2
fi

PERSONA="$VAULT/persona"
DUTY="${1:?usage: run-duty.sh <duty> [--dry-run]}"
DRY_RUN="${2:-}"
DUTY_FILE="$PERSONA/duties/$DUTY.md"
PERSONA_LOG_DIR="${PERSONA_LOG_DIR:-$PERSONA/journal/logs}"
LOG="$PERSONA_LOG_DIR/duty-$DUTY.log"
ERR="$PERSONA_LOG_DIR/duty-$DUTY-error.log"
MODEL=""; EFFORT=""                # persona/chief.js below (PERSONA_MODEL / PERSONA_EFFORT reach it through the env)
MAX_USD="${PERSONA_MAX_USD:-}"     # empty → persona.perDutyUsd from --check below → 2
# Scoped allowlist (not bypassPermissions): node is pinned to the persona scripts; git is limited to status, so a duty
# can neither commit nor push (final review F3/safety-5, departs from A26 — git add/commit were dropped:
# docs/chief-of-staff.md promises a duty never commits) nor write a file through `git log/diff --output=` (duty-write-scope
# D2). No Write/Edit here: duty-guard.js adds one Edit rule per path in the duty's write scope (D1).
PERSONA_TOOLS="${PERSONA_TOOLS:-Read,Glob,Grep,Bash(git status:*),Bash(date:*),Bash(ls:*),Bash(grep:*),Bash(wc:*),Bash(tail:*),Bash(head:*),Bash($NODE $VAULT/brain/scripts/persona/sitrep-state.js:*),Bash($NODE $VAULT/brain/scripts/persona/scan-arsenal.js:*),Bash($NODE $VAULT/brain/scripts/persona/ledger.js:*),Bash($NODE $VAULT/brain/scripts/persona/proposal-html.js:*),Bash($NODE $VAULT/brain/scripts/persona/reflect.js:*),Bash(node $VAULT/brain/scripts/persona/sitrep-state.js:*),Bash(node $VAULT/brain/scripts/persona/scan-arsenal.js:*),Bash(node $VAULT/brain/scripts/persona/ledger.js:*),Bash(node $VAULT/brain/scripts/persona/proposal-html.js:*),Bash(node $VAULT/brain/scripts/persona/reflect.js:*),Bash($NODE brain/scripts/persona/reflect.js:*),Bash(node brain/scripts/persona/reflect.js:*),Bash($NODE brain/scripts/persona/ledger.js:*),Bash($NODE brain/scripts/persona/proposal-html.js:*),Bash(node brain/scripts/persona/ledger.js:*),Bash(node brain/scripts/persona/proposal-html.js:*)}"
RECORD="$SCRIPT_DIR/record-spend.js"     # sibling: repo checkout in tests, <vault>/brain/scripts/persona/ when installed
TODAY="$(date +%Y-%m-%d)"
NOW="$(date +%H:%M)"
JOURNAL="$PERSONA/journal/$TODAY.md"
# The UTC day's journal, when it differs from the local one (the last hours of every local day west of UTC):
# a model that dates its entry from the UTC timestamps in tool output files it there. Counted by the contract
# check below so a misfiled entry is a log warning, not a FAILED duty.
UTC_JOURNAL="$PERSONA/journal/$(date -u +%Y-%m-%d).md"
[ "$UTC_JOURNAL" = "$JOURNAL" ] && UTC_JOURNAL=""
# duty_entries <file>: journal headers this duty wrote in <file> (0 when the file is missing).
duty_entries() {
  c=$(grep -c "duty: $DUTY" "$1" 2>/dev/null || true)
  echo "${c:-0}"
}
# flag_state <line>: <line> right under '## Flags' in STATE.md — portable insert (no sed -i).
flag_state() {
  [ -f "$PERSONA/STATE.md" ] || return 0
  TMP="$PERSONA/STATE.md.tmp.$$"
  awk -v line="$1" '{ print } /^## Flags[[:space:]]*$/ { print line }' "$PERSONA/STATE.md" > "$TMP" && mv "$TMP" "$PERSONA/STATE.md"
}
# flag_once <line>: flag_state unless STATE.md already holds exactly that line (a skipped duty flags once a day, not per run).
flag_once() {
  [ -f "$PERSONA/STATE.md" ] || return 0
  grep -qxF -- "$1" "$PERSONA/STATE.md" 2>/dev/null && return 0
  flag_state "$1"
}

if [ -f "$PERSONA/DISABLED" ]; then
  echo "persona DISABLED — skipping duty '$DUTY'"
  exit 0
fi
[ -f "$DUTY_FILE" ] || { echo "unknown duty '$DUTY' (no $DUTY_FILE)" >&2; exit 1; }

# claude binary: PERSONA_CLAUDE_BIN → hosts.claude.bin / claude.bin recorded by `aos init` (contract §2 addendum) → PATH →
# the usual install locations, resolved by chief.js (lib/headless.js resolveBin). execution amendment 2026-09-15 (A24)
# A SET PERSONA_CLAUDE_BIN that is not executable is a misconfiguration, not a cue to fall through to the
# PATH lookup — fail loudly instead of silently launching whatever `claude` happens to resolve to. (A50)
# Deliberately BELOW the kill switch and the unknown-duty check (final review safety-9 = spec-12): a disabled
# persona must exit 0 and an unknown duty must exit 1 with its own message, whatever a stale override names.
CLAUDE_BIN=""
if [ -n "${PERSONA_CLAUDE_BIN:-}" ] && [ ! -x "$PERSONA_CLAUDE_BIN" ]; then
  echo "run-duty: PERSONA_CLAUDE_BIN is not executable: $PERSONA_CLAUDE_BIN" >&2
  exit 1
fi

# Runner (codex-parity D4, local-first A4): persona/chief.js answers host, binary, model, effort and the Codex home
# (PERSONA_CLAUDE_BIN still pins the claude binary). Under codex there is no --max-budget-usd: the daily cap below still
# gates the start and the spend is estimated from the usage block afterwards (D5); the tools allowlist has no Codex form,
# the workspace-write sandbox is the guard. No node or no chief.js → the duty does not run (it needs both further down).
CHIEF="$SCRIPT_DIR/chief.js"
if [ -z "$NODE" ] || [ ! -x "$NODE" ] || [ ! -f "$CHIEF" ]; then
  echo "run-duty: node or chief.js missing — '$DUTY' does not run without its host" >&2
  exit 1
fi
CHIEF_ERR="/dev/null"; [ "$DRY_RUN" = "--dry-run" ] || { mkdir -p "$PERSONA_LOG_DIR"; CHIEF_ERR="$ERR"; }
RES="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$CHIEF" --resolve 2>>"$CHIEF_ERR")"; RC=$?
RUNNER=""; CODEX_BIN=""; CODEX_MODEL=""; CHIEF_REASON=""; SKIP=""; SKIP_DETAIL=""
case "$RC" in
  0) RUNNER="$(printf '%s' "$RES" | cut -f1)"
     MODEL="$(printf '%s' "$RES" | cut -f3)"; EFFORT="$(printf '%s' "$RES" | cut -f4)"; CHIEF_REASON="$(printf '%s' "$RES" | cut -f6)"
     if [ "$RUNNER" = "codex" ]; then
       CODEX_BIN="$(printf '%s' "$RES" | cut -f2)"; CODEX_MODEL="$MODEL"
       # The Codex home aos init recorded: a scheduled duty must use the same sessions and config (unless set already).
       CODEX_HOME_CFG="$(printf '%s' "$RES" | cut -f5)"; [ -n "$CODEX_HOME_CFG" ] && [ -z "${CODEX_HOME:-}" ] && export CODEX_HOME="$CODEX_HOME_CFG"
     else
       CLAUDE_BIN="$(printf '%s' "$RES" | cut -f2)"
     fi ;;
  3) SKIP="$(printf '%s' "$RES" | cut -f1)"; SKIP_DETAIL="$(printf '%s' "$RES" | cut -f2)" ;;
  *) echo "run-duty: chief.js failed (exit $RC) — '$DUTY' does not run" >&2; exit 1 ;;
esac
EFFORT="${EFFORT:-medium}"

# Nobody can start this duty (local-first A4): skipped, not failed — exit 0 so the routine counts the hour as a run.
if [ -n "$SKIP" ]; then
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "skipped: $SKIP ($SKIP_DETAIL)"
    exit 0
  fi
  mkdir -p "$PERSONA_LOG_DIR" "$PERSONA/journal"
  if [ "$SKIP" = "daily-cap" ]; then
    echo "[$(date)] duty=$DUTY skipped: daily spend cap reached ($SKIP_DETAIL)" >> "$LOG"
    {
      echo ""
      echo "## $(date +%H:%M) — duty: $DUTY"
      echo "- status: SKIPPED daily-cap"
      echo "- did: nothing — $SKIP_DETAIL, on both hosts"
    } >> "$JOURNAL"
    exit 0
  fi
  echo "[$(date)] duty=$DUTY skipped: waiting for a host ($SKIP_DETAIL)" >> "$LOG"
  {
    echo ""
    echo "## $(date +%H:%M) — duty: $DUTY"
    echo "- status: SKIPPED waiting-for-host"
    echo "- did: nothing — no host can start it ($SKIP_DETAIL); sign in to Claude Code or Codex, or turn one on with aos init --host"
  } >> "$JOURNAL"
  flag_once "- [ ] $TODAY Chief of Staff waiting for a host — duties skipped ($SKIP_DETAIL)"
  exit 0
fi

# Write scope (duty-write-scope D1/D2/D4/D5). No node or no duty-guard.js → no scope → the duty does not run.
GUARD="$SCRIPT_DIR/duty-guard.js"
if [ ! -f "$GUARD" ]; then
  echo "run-duty: node or duty-guard.js missing — '$DUTY' does not run without its write scope" >&2
  exit 1
fi
# duty_scope <host>: duty-guard.js scope; refused writes: entries go to the error log (stderr on a dry run). --duty adds
# the duty's built-in writes (the reflect duties' feedback memories, spec 2026-09-28-reflect-memory-writes-design D1).
duty_scope() {
  if [ "$DRY_RUN" = "--dry-run" ]; then
    AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$GUARD" scope --host "$1" --duty "$DUTY" --tools "$PERSONA_TOOLS" --writes "${PERSONA_WRITES:-}" --dry-run
  else
    mkdir -p "$PERSONA_LOG_DIR"
    AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$GUARD" scope --host "$1" --duty "$DUTY" --tools "$PERSONA_TOOLS" --writes "${PERSONA_WRITES:-}" 2>> "$ERR"
  fi
}
# Codex: the positional parameters become the `--add-dir <folder>` pairs (POSIX sh has no arrays; $1/$2 are read above).
# Claude: line 1 is the --allowedTools value, line 2 the --disallowedTools value.
ALLOWED=""; DENIED=""
if [ "$RUNNER" = "codex" ]; then
  ADD_DIRS="$(duty_scope codex)" || { echo "run-duty: duty-guard.js scope failed — '$DUTY' does not run" >&2; exit 1; }
  set --
  while IFS= read -r d; do [ -n "$d" ] && set -- "$@" --add-dir "$d"; done <<EOF
$ADD_DIRS
EOF
else
  SCOPE="$(duty_scope claude)" || { echo "run-duty: duty-guard.js scope failed — '$DUTY' does not run" >&2; exit 1; }
  ALLOWED="$(printf '%s\n' "$SCOPE" | sed -n 1p)"
  DENIED="$(printf '%s\n' "$SCOPE" | sed -n 2p)"
  set --
fi

# Hooks do not run under AOS_HEADLESS=1, so the persona is injected here instead.
# The date line pins "today": a duty running just after midnight otherwise infers the date from STATE.md and the
# journal (both still yesterday's), appends its entry to yesterday's file, and the contract check below reads FAILED.
SYSTEM="$( { echo "Today is $TODAY (local time $NOW). This run's journal file is $JOURNAL. Use this date and time for every date you write; timestamps in tool output are UTC."; echo; cat "$PERSONA/IDENTITY.md" 2>/dev/null; echo; echo '---'; cat "$PERSONA/STATE.md" 2>/dev/null; } )"
# The date line alone is not enough: a duty file says "append to journal/<today YYYY-MM-DD>.md" and "## <HH:MM>", and
# a small model fills those from the UTC ISO timestamps its scripts print — after 20:00 EDT that is tomorrow's file.
# So the placeholders arrive already filled with the local day and time. Literal index() replace, not gsub: no regex.
PROMPT="$(awk -v today="$TODAY" -v now="$NOW" '
  function fill(s, from, to,   out, i) { out = ""; while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) } return out s }
  { s = fill($0, "<today YYYY-MM-DD>", today); s = fill(s, "<today>", today); s = fill(s, "<YYYY-MM-DD>", today); print fill(s, "<HH:MM>", now) }
' "$DUTY_FILE")"

if [ "$DRY_RUN" = "--dry-run" ]; then
  if [ "$RUNNER" = "codex" ]; then
    printf '%s\n' "$CODEX_BIN" "exec" "-" "--skip-git-repo-check" "--ephemeral" "-s" "workspace-write" \
      "-C" "$PERSONA" "-c" "sandbox_workspace_write.writable_roots=[]" "$@" "-c" "features.hooks=false" \
      "--json" "-o" "<last message file>" ${CODEX_MODEL:+-m "$CODEX_MODEL"} "-c" "model_reasoning_effort=\"$EFFORT\"" \
      "<duty $DUTY on stdin, after persona IDENTITY.md + STATE.md>"
    [ "$CHIEF_REASON" = "${CHIEF_REASON#failover}" ] || echo "($CHIEF_REASON)"
    exit 0
  fi
  printf '%s\n' "$CLAUDE_BIN" "-p" "<duty $DUTY>" "--model" "$MODEL" "--effort" "$EFFORT" "--permission-mode" "dontAsk" \
    "--allowedTools" "$ALLOWED" "--disallowedTools" "$DENIED" "--max-budget-usd" "${MAX_USD:-2}" "--output-format" "json" \
    "--strict-mcp-config" "--no-session-persistence" \
    "--append-system-prompt" "<persona IDENTITY.md + STATE.md>"
  [ "$CHIEF_REASON" = "${CHIEF_REASON#failover}" ] || echo "($CHIEF_REASON)"
  exit 0
fi

mkdir -p "$PERSONA_LOG_DIR" "$PERSONA/journal"

# Daily duty cap from the provider spend ledger (exit 3 = capped; any other failure → proceed): one cap over both hosts,
# which chief.js checked already; this is the last word before the start, and the per-run budget.
# --check prints {"allowed":…,"spentToday":…,"perDayUsd":…,"perDutyUsd":…}; perDutyUsd is the
# per-run budget unless PERSONA_MAX_USD was set.
if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -f "$RECORD" ]; then
  CAPS="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$RECORD" --check 2>>"$ERR")"
  RC=$?
  if [ "$RC" -eq 3 ]; then
    echo "[$(date)] duty=$DUTY skipped: daily spend cap reached $CAPS" >> "$LOG"
    {
      echo ""
      echo "## $(date +%H:%M) — duty: $DUTY"
      echo "- status: SKIPPED daily-cap"
      echo "- did: nothing — today's duty spend is at persona.perDayUsd $CAPS"
    } >> "$JOURNAL"
    exit 0
  elif [ "$RC" -ne 0 ]; then
    # Neither allowed (0) nor capped (3) — the check itself failed. Proceed uncapped rather than block
    # every duty on a broken --check; --max-budget-usd still bounds what this one run can spend. (A50)
    echo "[$(date)] duty=$DUTY cap check failed (exit $RC) — proceeding uncapped; --max-budget-usd still bounds this run" >> "$LOG"
  fi
  [ -n "$MAX_USD" ] || MAX_USD="$(printf '%s' "$CAPS" | sed -n 's/.*"perDutyUsd":\([0-9][0-9.]*\).*/\1/p')"
fi
MAX_USD="${MAX_USD:-2}"

# Duty helper (spec 2026-09-22-persona-tick-design D3): a sibling script whose `precheck` verb exits 3 when nothing
# changed since the duty's last beat — the model call is skipped (one log line, no journal entry, exit 0, and
# run-routine.js still records the run, so the watchdog never mistakes an idle hour for a miss) — and whose `beat`
# verb runs after the duty met its contract. The daily reflect (spec 2026-09-22-persona-reflect-daily-design D2) uses the
# same seam: reflect.js `precheck` exits 3 when the queue is empty and today already drained; `beat` drains the queue.
# Named per duty on purpose: only these two have one, and a user duty that happens to share a script's name must never
# pick that script up.
case "$DUTY" in
  tick) HELPER="$SCRIPT_DIR/tick.js"; SKIP_WHY="unchanged since the last beat" ;;
  reflect-daily) HELPER="$SCRIPT_DIR/reflect.js"; SKIP_WHY="queue empty and already drained today" ;;
  *) HELPER=""; SKIP_WHY="" ;;
esac
if [ -n "$HELPER" ] && [ -f "$HELPER" ] && [ -n "$NODE" ] && [ -x "$NODE" ]; then
  PRE="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$HELPER" precheck --root "$VAULT" 2>>"$ERR")"
  if [ $? -eq 3 ]; then
    echo "[$(date)] duty=$DUTY skipped: $SKIP_WHY $PRE" >> "$LOG"
    exit 0
  fi
fi

# Guard (duty-write-scope D6/D7): snapshot the persona trust files outside the vault; no snapshot → no run.
if ! AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$GUARD" snapshot "$DUTY" >> "$LOG" 2>> "$ERR"; then
  echo "[$(date)] duty=$DUTY not run: duty-guard.js snapshot failed — see $ERR" >> "$LOG"
  exit 1
fi

LOG_MODEL="$MODEL"; [ "$RUNNER" = "codex" ] && LOG_MODEL="${CODEX_MODEL:-codex-default}"
echo "[$(date)] duty=$DUTY runner=$RUNNER model=$LOG_MODEL effort=$EFFORT budget=$MAX_USD ($CHIEF_REASON) start" >> "$LOG"
BEFORE_COUNT=$(duty_entries "$JOURNAL")
UTC_BEFORE=0; [ -n "$UTC_JOURNAL" ] && UTC_BEFORE=$(duty_entries "$UTC_JOURNAL")
OUT="$(mktemp "${TMPDIR:-/tmp}/duty-$DUTY.XXXXXX")"

IN=""
if [ "$RUNNER" = "codex" ]; then
  # The prompt goes on stdin from a file (not a pipe: `exec` must replace this subshell so the watchdog can kill
  # the codex process itself, and a pipeline element cannot do that). --json events land in $OUT for the ledger.
  IN="$(mktemp "${TMPDIR:-/tmp}/duty-$DUTY-in.XXXXXX")"
  { printf '%s\n\n---\n\n' "$SYSTEM"; printf '%s' "$PROMPT"; } > "$IN"
  # The workspace is persona/, not the vault (D4): the sandbox then refuses brain/scripts, workspaces/, .obsidian/ and
  # the vault's .git; "$@" adds the scope's other folders; an empty writable_roots drops any a user config.toml adds.
  ( cd "$PERSONA" && AOS_HEADLESS=1 exec "$CODEX_BIN" exec - --skip-git-repo-check --ephemeral -s workspace-write \
      -C "$PERSONA" -c 'sandbox_workspace_write.writable_roots=[]' "$@" \
      -c features.hooks=false --json -o "$OUT.msg" ${CODEX_MODEL:+-m "$CODEX_MODEL"} -c "model_reasoning_effort=\"$EFFORT\"" \
      < "$IN" > "$OUT" 2>> "$ERR" ) &
else
  # dontAsk: only the allowlist runs, whatever defaultMode the user's settings carry; the deny rules beat any allow rule.
  ( cd "$VAULT" && AOS_HEADLESS=1 exec "$CLAUDE_BIN" -p "$PROMPT" --model "$MODEL" --effort "$EFFORT" --permission-mode dontAsk \
      --allowedTools "$ALLOWED" --disallowedTools "$DENIED" --max-budget-usd "$MAX_USD" --output-format json \
      --strict-mcp-config --no-session-persistence \
      --append-system-prompt "$SYSTEM" > "$OUT" 2>> "$ERR" ) &
fi
CLAUDE_PID=$!
# `exec` replaces the backgrounded subshell with $CLAUDE_BIN itself, so $! above is the claude process,
# not a wrapper shell around it — without exec, killing $! only kills the subshell and claude is
# reparented to init, orphaned and still spending (A49). Watchdog: the killer owns and reaps its own
# sleep. A plain `( sleep N; kill … ) &` leaves the sleep orphaned when the killer is killed, and that
# sleep holds the inherited stdout/stderr open — spawnSync in run-duty.test.js then blocks for the full
# PERSONA_TIMEOUT, and under launchd/cron every duty leaves a 30-minute sleep behind. With the trap,
# `kill "$KILLER_PID"` ends the sleep too.
( sleep "${PERSONA_TIMEOUT:-1800}" & S=$!; trap 'kill "$S" 2>/dev/null; exit 0' TERM; wait "$S"; kill "$CLAUDE_PID" 2>/dev/null ) &
KILLER_PID=$!
wait "$CLAUDE_PID"; STATUS=$?
kill "$KILLER_PID" 2>/dev/null; wait "$KILLER_PID" 2>/dev/null

# Guard check before anything else runs from the vault: exit 4 = guarded files restored (duty-guard.js flagged STATE.md
# and kept the duty's version); any other non-zero = the check itself failed. A clean check that backfilled MEMORY.md
# lines for the duty's new feedback memories (reflect-memory-writes D3) is logged too.
GUARD_RC=0
GUARD_OUT="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$GUARD" check "$DUTY" --keep "$PERSONA_LOG_DIR" 2>> "$ERR")" || GUARD_RC=$?
if [ "$GUARD_RC" -ne 0 ]; then
  echo "[$(date)] duty=$DUTY guard exit $GUARD_RC $GUARD_OUT" >> "$LOG"
else
  case "$GUARD_OUT" in *'"indexed"'*|*'"indexError"'*) echo "[$(date)] duty=$DUTY guard $GUARD_OUT" >> "$LOG" ;; esac
fi

cat "$OUT" >> "$LOG"
if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -f "$RECORD" ] && [ -s "$OUT" ]; then
  SPEND_MODEL="$MODEL"; [ "$RUNNER" = "codex" ] && SPEND_MODEL="${CODEX_MODEL:-codex-default}"
  AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$RECORD" --file "$OUT" --feature "duty:$DUTY" --model "$SPEND_MODEL" >> "$LOG" 2>> "$ERR" || true
fi
rm -f "$OUT" "$OUT.msg"; [ -n "$IN" ] && rm -f "$IN"

# A duty that wrote a guarded file failed, whatever it journaled; no helper beat follows.
if [ "$GUARD_RC" -ne 0 ]; then
  {
    echo ""
    echo "## $(date +%H:%M) — duty: $DUTY"
    echo "- status: FAILED"
    echo "- did: runner-detected guard failure (duty-guard exit $GUARD_RC) — see $LOG"
  } >> "$JOURNAL"
  [ "$GUARD_RC" -eq 4 ] || flag_state "- [ ] $TODAY duty '$DUTY' FAILED — its guard check did not complete (exit $GUARD_RC), check $ERR"
  echo "[$(date)] duty=$DUTY FAILED (guard exit $GUARD_RC)" >> "$LOG"
  exit 1
fi

# Duty contract check: the duty must have added a NEW journal entry this run
# (a plain grep would match a prior run's watchdog entry and self-satisfy). An entry filed under the UTC day
# still counts — the duty did its work — but it is logged so the misfiling is visible.
AFTER_COUNT=$(duty_entries "$JOURNAL")
if [ "$AFTER_COUNT" -le "$BEFORE_COUNT" ] && [ -n "$UTC_JOURNAL" ] && [ "$(duty_entries "$UTC_JOURNAL")" -gt "$UTC_BEFORE" ]; then
  echo "[$(date)] duty=$DUTY journal entry landed in $UTC_JOURNAL (the UTC day), not $JOURNAL — counted" >> "$LOG"
  AFTER_COUNT=$((BEFORE_COUNT + 1))
fi
if [ "$AFTER_COUNT" -le "$BEFORE_COUNT" ]; then
  {
    echo ""
    echo "## $(date +%H:%M) — duty: $DUTY"
    echo "- status: FAILED"
    echo "- did: runner-detected failure (exit $STATUS, no journal entry) — see $ERR"
  } >> "$JOURNAL"
  flag_state "- [ ] $TODAY duty '$DUTY' FAILED — check $ERR"
  # No commit here: the vault template ignores persona/journal/ and persona/STATE.md, and a background job must
  # never run a pathspec-less `git commit` over whatever the user had staged. execution amendment 2026-09-15 (A7)
  echo "[$(date)] duty=$DUTY FAILED (contract unmet)" >> "$LOG"
  exit 1
fi

if [ -n "$HELPER" ] && [ -f "$HELPER" ] && [ -n "$NODE" ] && [ -x "$NODE" ]; then
  AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$HELPER" beat --root "$VAULT" >> "$LOG" 2>>"$ERR" || true
fi
echo "[$(date)] duty=$DUTY done (exit $STATUS)" >> "$LOG"
