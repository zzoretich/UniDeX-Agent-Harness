#!/bin/sh
# Stand-in for the `codex` CLI in tests and the CI rehearsal. Records every call, answers the read-only
# queries cli/codex-host.js makes, and keeps one piece of state: the MCP registration, in the file named
# by FAKE_CODEX_STATE (so `mcp get` after `mcp add` reports what was added, and `mcp remove` clears it).
# Line 1 of that file is the launcher, line 2 records whether `--env AOS_HOST=codex` was passed, so a
# registration written the 0.5.0 way (no host env) reads back as stale, exactly like the real CLI.
# Knobs: FAKE_CODEX_LOGGED_OUT=1 makes `login status` report no login; FAKE_CODEX_FAIL_MCP=1 makes
# `mcp add` fail, to exercise the allowFail path without touching the network.
# With CODEX_HOME set, `mcp add` and `mcp remove` also edit "$CODEX_HOME/config.toml" the way codex-cli 0.167 does
# (checked in a scratch Codex home): remove drops every [mcp_servers.agenticos…] table, the per-tool approvals among
# them (agent-computer D33); add writes the server's own tables in place of any it had.
#
# Plugins (design 2026-09-23-codex-plugin), answered the way Codex 0.155.1 did in the design spike: the marketplace
# source lives in "$FAKE_CODEX_STATE.mkt", the installed plugin version in "$FAKE_CODEX_STATE.plugin" (read from
# <source>/codex-plugin/.codex-plugin/plugin.json when the source is a checkout). `marketplace add` from the same
# source reports alreadyAdded, from another source is refused; `marketplace upgrade` refuses a local source;
# `mcp list` shows the plugin's server beside a direct registration. FAKE_CODEX_NO_PLUGINS=1 is a CLI that predates
# plugins; FAKE_CODEX_FAIL_PLUGIN=1 makes `plugin add` fail.
echo "$*" >> "${FAKE_CODEX_LOG:-/dev/null}"
STATE="${FAKE_CODEX_STATE:-}"
PSTATE="${STATE:+$STATE.plugin}"
MSTATE="${STATE:+$STATE.mkt}"
# drop_server — config.toml in the Codex home without any [mcp_servers.agenticos…] table. Like Codex, the blank lines
# before a dropped table go with it; those before a table that stays, stay.
drop_server() {
  [ -n "${CODEX_HOME:-}" ] && [ -f "$CODEX_HOME/config.toml" ] || return 0
  awk '
    /^[[:space:]]*$/ { blanks = blanks $0 "\n"; next }
    /^[[:space:]]*\[/ { skip = ($0 ~ /^[[:space:]]*\[mcp_servers\.agenticos[].]/) }
    skip { blanks = ""; next }
    { printf "%s", blanks; blanks = ""; print }
    END { if (!skip) printf "%s", blanks }
  ' "$CODEX_HOME/config.toml" > "$CODEX_HOME/config.toml.fake" && mv "$CODEX_HOME/config.toml.fake" "$CODEX_HOME/config.toml"
}
PLUGIN_SERVER='{"name":"agenticos","enabled":true,"transport":{"type":"stdio","command":"sh","args":["./bin/aos","mcp-server"],"env":{"AOS_HOST":"codex"},"cwd":"/fake/plugins/cache/agenticos-workbench/agenticos/."}}'
if [ "$1" = "plugin" ] && [ "${FAKE_CODEX_NO_PLUGINS:-}" = "1" ]; then echo "error: unrecognized subcommand 'plugin'" >&2; exit 2; fi
# sdk/lib/codex-cli.js puts `-` (stdin) last, lib/headless.js right after `exec`: both are the same headless run here.
KEY="$1 $2"; [ "$1" = "exec" ] && KEY="exec -"
case "$KEY" in
  "--version ") echo "codex-cli 0.0.0-fake" ;;
  "plugin list")
    if [ -n "$PSTATE" ] && [ -f "$PSTATE" ]; then
      printf '{"installed":[{"pluginId":"agenticos@agenticos-workbench","name":"agenticos","marketplaceName":"agenticos-workbench","version":"%s","installed":true,"enabled":true}],"available":[]}\n' "$(sed -n 1p "$PSTATE")"
    else
      echo '{"installed":[],"available":[]}'
    fi ;;
  "plugin marketplace")
    case "$3" in
      add)
        if [ -n "$MSTATE" ] && [ -f "$MSTATE" ]; then
          if [ "$(cat "$MSTATE")" = "$4" ]; then echo '{"marketplaceName":"agenticos-workbench","alreadyAdded":true}'
          else echo "Error: marketplace 'agenticos-workbench' is already added from a different source; remove it before adding this source" >&2; exit 1; fi
        else
          [ -n "$MSTATE" ] && printf '%s' "$4" > "$MSTATE"
          echo '{"marketplaceName":"agenticos-workbench","alreadyAdded":false}'
        fi ;;
      upgrade)
        if [ -n "$MSTATE" ] && [ -f "$MSTATE" ] && ! grep -q '^/' "$MSTATE"; then echo "Upgraded marketplace agenticos-workbench"
        else echo 'Error: marketplace `agenticos-workbench` is not configured as a Git marketplace' >&2; exit 1; fi ;;
      list)
        # A local source is its own root; a git source's snapshot root is FAKE_CODEX_MKT_ROOT (Codex keeps it under its home).
        if [ -n "$MSTATE" ] && [ -f "$MSTATE" ]; then
          SRC=$(cat "$MSTATE"); case "$SRC" in /*) ROOT="$SRC"; TYPE=local ;; *) ROOT="${FAKE_CODEX_MKT_ROOT:-}"; TYPE=git ;; esac
          printf '{"marketplaces":[{"name":"agenticos-workbench","root":"%s","marketplaceSource":{"sourceType":"%s","source":"%s"}}]}\n' "$ROOT" "$TYPE" "$SRC"
        else echo '{"marketplaces":[]}'; fi ;;
      remove)
        if [ -n "$MSTATE" ] && [ -f "$MSTATE" ]; then rm -f "$MSTATE"; echo 'Removed marketplace `agenticos-workbench`.'
        else echo 'Error: marketplace `agenticos-workbench` is not configured or installed' >&2; exit 1; fi ;;
    esac ;;
  "plugin add")
    if [ "${FAKE_CODEX_FAIL_PLUGIN:-}" = "1" ]; then echo "Error: fake: plugin add failed" >&2; exit 1; fi
    SRC=""; [ -n "$MSTATE" ] && [ -f "$MSTATE" ] && SRC=$(cat "$MSTATE")
    if [ -n "$MSTATE" ] && [ -z "$SRC" ]; then echo "Error: marketplace 'agenticos-workbench' is not configured" >&2; exit 1; fi
    V=""; [ -f "$SRC/codex-plugin/.codex-plugin/plugin.json" ] && V=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/codex-plugin/.codex-plugin/plugin.json" | head -n 1)
    [ -n "$V" ] || V="0.0.0-fake"
    [ -n "$PSTATE" ] && printf '%s\n' "$V" > "$PSTATE"
    printf '{"pluginId":"agenticos@agenticos-workbench","name":"agenticos","marketplaceName":"agenticos-workbench","version":"%s","installedPath":"/fake/plugins/cache/agenticos-workbench/agenticos/%s"}\n' "$V" "$V" ;;
  "plugin remove")
    [ -n "$PSTATE" ] && rm -f "$PSTATE"
    echo 'Removed plugin `agenticos` from marketplace `agenticos-workbench`.' ;;
  "mcp list")
    SEP=""; printf '['
    if [ -n "$PSTATE" ] && [ -f "$PSTATE" ]; then printf '%s' "$PLUGIN_SERVER"; SEP=","; fi
    if [ -n "$STATE" ] && [ -f "$STATE" ]; then
      printf '%s{"name":"agenticos","enabled":true,"transport":{"type":"stdio","command":"sh","args":["%s","mcp-server"],"env":{"AOS_CONFIG":"x","AOS_HOST":"codex"}}}' "$SEP" "$(sed -n 1p "$STATE")"
    fi
    printf ']\n' ;;
  "login status")
    if [ "${FAKE_CODEX_LOGGED_OUT:-}" = "1" ]; then echo "Not logged in"; exit 1; fi
    echo "Logged in using ChatGPT" ;;
  "mcp get")
    if [ -n "$STATE" ] && [ -f "$STATE" ]; then
      LAUNCHER=$(sed -n 1p "$STATE"); HOSTENV=$(sed -n 2p "$STATE")
      if [ "$HOSTENV" = "AOS_HOST=codex" ]; then ENVJSON='{"AOS_CONFIG":"x","AOS_HOST":"codex"}'; else ENVJSON='{"AOS_CONFIG":"x"}'; fi
      printf '{"name":"agenticos","enabled":true,"transport":{"type":"stdio","command":"sh","args":["%s","mcp-server"],"env":%s}}\n' "$LAUNCHER" "$ENVJSON"
    elif [ -n "$PSTATE" ] && [ -f "$PSTATE" ]; then
      echo "$PLUGIN_SERVER"
    else
      echo "No MCP server named 'agenticos'" >&2
      exit 1
    fi ;;
  "mcp add")
    if [ "${FAKE_CODEX_FAIL_MCP:-}" = "1" ]; then echo "fake: mcp add failed" >&2; exit 1; fi
    HOSTENV=""; for a in "$@"; do [ "$a" = "AOS_HOST=codex" ] && HOSTENV="AOS_HOST=codex"; done
    # the server's env table, from each `--env K=V` before `--`
    ENVTOML=""; PREV=""
    for a in "$@"; do
      [ "$a" = "--" ] && break
      [ "$PREV" = "--env" ] && ENVTOML="$ENVTOML${a%%=*} = \"${a#*=}\"
"
      PREV="$a"
    done
    # the launcher is the argument right after `-- sh`
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ -n "$STATE" ] && [ $# -ge 3 ] && printf '%s\n%s\n' "$3" "$HOSTENV" > "$STATE"
    if [ -n "${CODEX_HOME:-}" ] && [ $# -ge 3 ]; then
      drop_server
      printf '\n[mcp_servers.agenticos]\ncommand = "sh"\nargs = ["%s", "mcp-server"]\n' "$3" >> "$CODEX_HOME/config.toml"
      [ -n "$ENVTOML" ] && printf '\n[mcp_servers.agenticos.env]\n%s' "$ENVTOML" >> "$CODEX_HOME/config.toml"
    fi ;;
  "mcp remove")
    # Like the real CLI: exit 0 either way, and never touches a plugin's server.
    drop_server
    if [ -n "$STATE" ] && [ -f "$STATE" ]; then rm -f "$STATE"; echo "Removed global MCP server 'agenticos'."
    else echo "No MCP server named 'agenticos' found."; fi ;;
  "exec -")
    # A headless run (lib/headless.js codex runner): the prompt is on stdin, the final message goes to the -o file,
    # the --json event stream to stdout. FAKE_CODEX_STDIN captures the prompt, FAKE_ARGS the argv (like fake-claude),
    # FAKE_JOURNAL appends a journal entry for duty FAKE_DUTY (default testduty) so run-duty.sh sees its contract met,
    # and FAKE_TAMPER appends a line to that file (a write the duty made, as with fake-claude).
    PROMPT_IN=$(cat)
    [ -n "${FAKE_CODEX_STDIN:-}" ] && printf '%s' "$PROMPT_IN" > "$FAKE_CODEX_STDIN"
    [ -n "${FAKE_ARGS:-}" ] && printf '%s\n' "$@" > "$FAKE_ARGS"
    [ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf '\n## 09:00 — duty: %s\n- status: OK\n' "${FAKE_DUTY:-testduty}" >> "$FAKE_JOURNAL"; }
    [ -n "${FAKE_TAMPER:-}" ] && { mkdir -p "$(dirname "$FAKE_TAMPER")"; echo tampered >> "$FAKE_TAMPER"; }
    OUTF=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && OUTF="$2"; shift; done
    # FAKE_CODEX_REPLY is the final message (default "fake reply"); FAKE_CODEX_EXIT fails the run after the events.
    REPLY="${FAKE_CODEX_REPLY:-fake reply}"
    [ -n "$OUTF" ] && printf '%s\n' "$REPLY" > "$OUTF"
    printf '{"type":"thread.started","thread_id":"fake"}\n{"type":"item.completed","item":{"type":"agent_message","text":"fake reply"}}\n{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":0,"output_tokens":300}}\n'
    [ -n "${FAKE_CODEX_EXIT:-}" ] && exit "$FAKE_CODEX_EXIT" ;;
esac
exit 0
