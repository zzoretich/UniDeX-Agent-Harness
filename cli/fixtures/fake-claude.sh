#!/bin/sh
# Stand-in for the `claude` CLI in tests and the CI rehearsal. Records every call, answers the
# read-only queries cli/aos.js makes, and exits 0 for everything else (install/uninstall/marketplace).
# Test knobs: FAKE_CLAUDE_FAIL_INSTALL=1 makes `plugin install` print to stderr and exit 1, to
# exercise installPlugin()'s allowFail path without touching the network; FAKE_CLAUDE_LOGGED_OUT=1 makes
# `auth status` report no login (aos hosts add refuses a signed-out host).
echo "$*" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
# `claude -p … --output-format json` (the graph shim's calls): read the prompt from stdin, answer one JSON envelope.
# Knobs: FAKE_CLAUDE_ENV_LOG (the env the call saw), FAKE_CLAUDE_USD (its cost), FAKE_CLAUDE_P_EXIT (fail it).
if [ "$1" = "-p" ]; then
  [ -n "${FAKE_CLAUDE_ENV_LOG:-}" ] && echo "MAX_THINKING_TOKENS=${MAX_THINKING_TOKENS:-} AOS_HEADLESS=${AOS_HEADLESS:-} CLAUDECODE=${CLAUDECODE:-} ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+set}" >> "$FAKE_CLAUDE_ENV_LOG"
  cat > /dev/null
  if [ -n "${FAKE_CLAUDE_P_EXIT:-}" ]; then echo "fake: -p failed" >&2; exit "$FAKE_CLAUDE_P_EXIT"; fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"nodes":[],"edges":[]},"total_cost_usd":%s,"usage":{"input_tokens":1200,"cache_read_input_tokens":100,"output_tokens":300},"duration_api_ms":900}\n' "${FAKE_CLAUDE_USD:-0.004}"
  exit 0
fi
# `plugin marketplace list --json`: FAKE_MARKETPLACE_DIR registers agenticos-workbench as a local directory marketplace.
if [ "$1 $2 $3" = "plugin marketplace list" ]; then
  if [ -n "${FAKE_MARKETPLACE_DIR:-}" ]; then
    printf '[{"name":"agenticos-workbench","source":"directory","path":"%s","installLocation":"%s"}]\n' "$FAKE_MARKETPLACE_DIR" "$FAKE_MARKETPLACE_DIR"
  else
    echo '[]'
  fi
  exit 0
fi
case "$1 $2" in
  "--version ") echo "0.0.0-fake (Claude Code)" ;;
  "auth status")
    if [ "${FAKE_CLAUDE_LOGGED_OUT:-}" = "1" ]; then echo '{"loggedIn":false}'; else echo '{"loggedIn":true,"authMethod":"fake"}'; fi ;;
  "plugin list")
    if [ -n "${FAKE_PLUGIN_PATH:-}" ]; then
      printf '[{"id":"agenticos@agenticos-workbench","version":"0.1.0","scope":"user","enabled":true,"installPath":"%s"}]\n' "$FAKE_PLUGIN_PATH"
    else
      echo '[]'
    fi ;;
  "plugin install")
    if [ "${FAKE_CLAUDE_FAIL_INSTALL:-}" = "1" ]; then
      echo "fake: install failed" >&2
      exit 1
    fi ;;
esac
exit 0
