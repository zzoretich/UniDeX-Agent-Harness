#!/bin/sh
# Stand-in for the pinned `graphify` binary (fake-uv.sh installs it). `--version` reports what fake-uv recorded;
# `update <dir>` writes a small fixed graph into $GRAPHIFY_OUT the way graphify 0.9.66 does. No network, no model.
# Knobs: FAKE_GRAPHIFY_LOG (args + a few env probes per call), FAKE_GRAPHIFY_EXIT + FAKE_GRAPHIFY_STDERR (fail),
# FAKE_GRAPHIFY_SLEEP (seconds, to prove the timeout), FAKE_GRAPHIFY_LOCAL_FAIL (a local backend's chunk fails).
here=$(dirname "$0")
local_env=""
[ -n "${OLLAMA_BASE_URL:-}${OPENAI_BASE_URL:-}" ] && local_env=" local=${OLLAMA_BASE_URL:-}${OPENAI_BASE_URL:-} model=${OLLAMA_MODEL:-}${OPENAI_MODEL:-} key=${OLLAMA_API_KEY:-}${OPENAI_API_KEY:-}"
[ -n "${FAKE_GRAPHIFY_LOG:-}" ] && echo "$* | out=${GRAPHIFY_OUT:-} nobackup=${GRAPHIFY_NO_BACKUP:-} apikey=${ANTHROPIC_API_KEY:+set}${OPENAI_API_KEY:+set}$local_env" >> "$FAKE_GRAPHIFY_LOG"
case "$1" in
  --version) echo "graphify $(cat "$here/.fake-graphify-version" 2>/dev/null || echo 0.0.0)" ;;
  update)
    [ -n "${FAKE_GRAPHIFY_SLEEP:-}" ] && exec sleep "$FAKE_GRAPHIFY_SLEEP"
    if [ -n "${FAKE_GRAPHIFY_EXIT:-}" ]; then echo "${FAKE_GRAPHIFY_STDERR:-error: fake failure}" >&2; exit "$FAKE_GRAPHIFY_EXIT"; fi
    [ -d "${2:-}" ] || { echo "error: path not found: ${2:-}" >&2; exit 1; }
    out="${GRAPHIFY_OUT:-$2/graphify-out}"
    mkdir -p "$out"
    if [ -f "$out/graph.json" ] && ! grep -q '"nodes"' "$out/graph.json"; then
      echo "error: Cannot read $out/graph.json for incremental merge: Expecting value. Delete the file and run a full rebuild." >&2
      exit 1
    fi
    cat > "$out/graph.json" <<'JSON'
{"directed": false, "multigraph": false, "graph": {}, "nodes": [
  {"id": "memory_index", "label": "MEMORY", "file_type": "document", "source_file": "MEMORY.md", "community": 0, "community_name": "Memory"},
  {"id": "agenticos", "label": "AGENTICOS", "file_type": "document", "source_file": "AGENTICOS.md", "community": 0, "community_name": "Memory"},
  {"id": "profile", "label": "profile", "file_type": "document", "source_file": "brain/memory/user/profile.md", "community": 0, "community_name": "Memory"},
  {"id": "todo", "label": "To-Do", "file_type": "document", "source_file": "TODO.md", "community": 1, "community_name": "Tasks"},
  {"id": "patterns_readme", "label": "Patterns", "file_type": "document", "source_file": "brain/patterns/README.md", "community": 1, "community_name": "Tasks"}
], "links": [
  {"source": "memory_index", "target": "agenticos", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "MEMORY.md"},
  {"source": "memory_index", "target": "profile", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "MEMORY.md"},
  {"source": "agenticos", "target": "todo", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "AGENTICOS.md"},
  {"source": "agenticos", "target": "patterns_readme", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "AGENTICOS.md"},
  {"source": "todo", "target": "patterns_readme", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "TODO.md"}
], "hyperedges": []}
JSON
    echo "[graphify update] wrote $out/graph.json: 5 nodes, 5 edges, 2 communities"
    ;;
  extract)
    # Like graphify's claude-cli backend: the prompt on stdin to whatever `claude` is first on PATH (the graph shim),
    # one JSON envelope back. A failed call leaves the run incomplete, not failed (the worker passes --allow-partial).
    [ -n "${FAKE_GRAPHIFY_SLEEP:-}" ] && exec sleep "$FAKE_GRAPHIFY_SLEEP"
    if [ -n "${FAKE_GRAPHIFY_EXIT:-}" ]; then echo "${FAKE_GRAPHIFY_STDERR:-error: fake failure}" >&2; exit "$FAKE_GRAPHIFY_EXIT"; fi
    [ -d "${2:-}" ] || { echo "error: path not found: ${2:-}" >&2; exit 1; }
    out="${GRAPHIFY_OUT:-$2/graphify-out}"
    mkdir -p "$out"
    concept=''
    case " $* " in
      *" --backend ollama "*|*" --backend openai "*) local_backend=1 ;;
      *) local_backend='' ;;
    esac
    if [ -n "$local_backend" ]; then
      # graphify's local backends answer over HTTP from the server named by env; the stand-in just reads the knob.
      if [ -z "${FAKE_GRAPHIFY_LOCAL_FAIL:-}" ]; then
        concept=', {"id": "concept_memory", "label": "long-term memory", "file_type": "concept", "community": 0, "community_name": "Memory"}'
        edge=', {"source": "memory_index", "target": "concept_memory", "relation": "describes", "confidence": "INFERRED", "weight": 0.8}'
      else
        echo "warning: semantic extraction is incomplete: 1 chunk(s) failed" >&2
        edge=''
      fi
    elif printf 'Extract a knowledge graph from these notes.\n' | claude -p --output-format json --no-session-persistence ${GRAPHIFY_CLAUDE_CLI_MODEL:+--model "$GRAPHIFY_CLAUDE_CLI_MODEL"} --json-schema '{"type":"object"}' > "$out/.fake-envelope.json"; then
      concept=', {"id": "concept_memory", "label": "long-term memory", "file_type": "concept", "community": 0, "community_name": "Memory"}'
      edge=', {"source": "memory_index", "target": "concept_memory", "relation": "describes", "confidence": "INFERRED", "weight": 0.8}'
    else
      echo "warning: semantic extraction is incomplete: 1 chunk(s) failed" >&2
      edge=''
    fi
    cat > "$out/graph.json" <<JSON
{"directed": false, "multigraph": false, "graph": {}, "nodes": [
  {"id": "memory_index", "label": "MEMORY", "file_type": "document", "source_file": "MEMORY.md", "community": 0, "community_name": "Memory"},
  {"id": "agenticos", "label": "AGENTICOS", "file_type": "document", "source_file": "AGENTICOS.md", "community": 0, "community_name": "Memory"}$concept
], "links": [
  {"source": "memory_index", "target": "agenticos", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "MEMORY.md"}$edge
], "hyperedges": []}
JSON
    echo "[graphify extract] wrote $out/graph.json"
    ;;
  *) exit 0 ;;
esac
