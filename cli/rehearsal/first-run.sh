#!/bin/sh
# First-run rehearsal (spec §14): a fresh HOME and Claude config dir, `aos init` with the fake
# claude CLI, then scan, compile, MCP recall, wrap_session, doctor, and uninstall --keep-vault.
# Needs: node >= 20 and npm on PATH, network for `npm install` inside the vendored runtime.
# Run from anywhere: sh cli/rehearsal/first-run.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
export HOME="$TMP/home" CLAUDE_CONFIG_DIR="$TMP/cfg"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"
echo '{}' > "$CLAUDE_CONFIG_DIR/settings.json"
BEFORE=$(ls -A "$CLAUDE_CONFIG_DIR" | sort)
export AOS_CLAUDE_BIN="$ROOT/cli/fixtures/fake-claude.sh" FAKE_CLAUDE_LOG="$TMP/claude.log"
# This is the Claude-only rehearsal: a codex CLI on the runner must not turn it into a two-host install.
export AOS_NO_CODEX=1
# mandatory-prereqs D6: the install gate needs Ollama present. The fixture proves the positive path on a bare runner;
# python3 is real on both CI images. Obsidian is no prerequisite (workbench-app D1): nothing here provides it.
export AOS_OLLAMA_BIN="$ROOT/cli/fixtures/fake-ollama.sh"
# graphify spec D1/§5: uv is a prerequisite as well. The fake installs a fake graphify under the temp HOME, with no network.
export AOS_UV_BIN="$ROOT/cli/fixtures/fake-uv.sh"
unset XDG_DATA_HOME || true
# FAKE_PLUGIN_PATH is NOT set yet: with it, fake-claude's `plugin list --json` reports the plugin as installed,
# installPlugin() takes the "plugin already installed" branch, and the `plugin install` grep below would fail.
unset AOS_VAULT BRAIN_VAULT AOS_CONFIG CLAUDE_PROJECT_DIR || true
VAULT="$TMP/aos"

echo "== init"
node "$ROOT/cli/aos.js" init --vault "$VAULT" --provider none --persona-json "$ROOT/cli/fixtures/persona.json" --yes

echo "== seed set"
for f in MEMORY.md AGENTICOS.md TODO.md .gitignore brain/config.json brain/_index/SESSION.md brain/_index/BRAIN.md \
    brain/_index/MOC-reference.md brain/_index/MOC-projects.md brain/_index/MOC-patterns.md brain/_index/scanner-config.json \
    brain/memory/user/profile.md brain/patterns/README.md templates/daily-note.md templates/meeting-note.md \
    templates/decision-record.md templates/project-note.md \
    brain/routines/monitor.md brain/routines/reflect.md brain/routines/sitrep.md \
    brain/scripts/package.json brain/scripts/bin/aos brain/scripts/cli/aos.js brain/scripts/routines/run-routine.js \
    brain/scripts/node_modules/@modelcontextprotocol/sdk/package.json .graphifyignore brain/graphify-out/graph.json; do
  [ -e "$VAULT/$f" ] || { echo "missing $f"; exit 1; }
done
# The Workbench is the app: init installs no HUD into the vault and seeds no Obsidian settings.
[ ! -e "$VAULT/.obsidian" ] || { echo "unexpected .obsidian"; exit 1; }
[ -f "$CLAUDE_CONFIG_DIR/agenticos.json" ]
grep -q '"provider": "none"' "$CLAUDE_CONFIG_DIR/agenticos.json"
grep -q '^plugin install agenticos@agenticos-workbench$' "$FAKE_CLAUDE_LOG"
[ -x "$HOME/.local/share/agenticos/graphify/bin/graphify" ] || { echo "graphify not installed into the tool dir"; exit 1; }

echo "== graph"
sh "$VAULT/brain/scripts/bin/aos" graph | grep -q '^5 nodes · 5 edges · 2 communities$'

echo "== scan + compile through the launcher"
AOS="$VAULT/brain/scripts/bin/aos"
AOS_DETACHED=1 sh "$AOS" scan-vault --quiet
AOS_DETACHED=1 sh "$AOS" build-brain-md
[ -f "$VAULT/brain/_index/snapshot.json" ]
[ -f "$VAULT/brain/_index/recall-index.json" ]
grep -q '^## Who' "$VAULT/brain/_index/BRAIN.md"

echo "== routines through the launcher (fixture persona says schedule: false — list and next only)"
sh "$AOS" routines list | grep -q '^monitor .*duty .*on .*Every day at 13:00'
sh "$AOS" routines next sitrep | grep -q '^sitrep: Weekdays at 07:45'

echo "== MCP recall over stdio"
node "$ROOT/cli/rehearsal/mcp-call.js" recall '{"query":"workbench vault profile"}' | grep -q 'brain/memory/user/profile.md'

echo "== the recall left a usage row tagged claude (brain-hub D9: paths only)"
grep -q '"host":"claude","how":"recalled","path":"brain/memory/user/profile.md"' "$VAULT/brain/_index/memory-usage.jsonl"

echo "== graph_overview over stdio (the graph init's first scan built)"
node "$ROOT/cli/rehearsal/mcp-call.js" graph_overview '{}' | grep -Eq '"nodes": ?5'

echo "== wrap_session writes a memory and a MEMORY.md line"
node "$ROOT/cli/rehearsal/mcp-call.js" wrap_session '{"facts":["The first-run rehearsal ran."],"decisions":[],"feedback":[],"threads":[],"candidates":[{"type":"reference","title":"Rehearsal marker","description":"Written by the CI first-run rehearsal through wrap_session.","body":"This memory proves that wrap_session writes through the shared memory writer. It was created by cli/rehearsal/first-run.sh in a throwaway vault. It is safe to delete."}]}' | grep -Eq '"written": ?1'
[ -f "$VAULT/brain/memory/reference/rehearsal-marker.md" ]
grep -q 'rehearsal-marker.md' "$VAULT/MEMORY.md"

echo "== Spaces counts a Claude Code session started in a workspace (spaces-redesign D20)"
# Claude Code keeps a transcript in projects/<slug>/<id>.jsonl, the slug being the start folder's real path with every
# character but a letter or digit turned into "-". The workspace's own "-" is lost in the slug, so only the cwd inside
# the transcript can attribute it.
sh "$AOS" workspace new reh-claude > /dev/null
WS=$(cd "$VAULT/workspaces/reh-claude" && pwd -P)
SLUG=$(printf '%s' "$WS" | sed 's/[^A-Za-z0-9]/-/g')
SID=c1a0de00-0000-4000-8000-0000000000aa
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$CLAUDE_CONFIG_DIR/projects/$SLUG"
printf '{"type":"user","sessionId":"%s","cwd":"%s","entrypoint":"cli","timestamp":"%s","message":{"role":"user","content":"Plan the rehearsal workspace"}}\n' \
  "$SID" "$WS" "$NOW" > "$CLAUDE_CONFIG_DIR/projects/$SLUG/$SID.jsonl"
AOS_DETACHED=1 sh "$AOS" scan-vault --quiet
sh "$AOS" workspace list --json > "$TMP/workspaces.json"
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const w = j.workspaces.find((x) => x.name === "reh-claude");
const s = w && w.sessions;
if (!s || !(s.claude >= 1)) throw new Error("reh-claude sessions: " + JSON.stringify(s));
if (!(s.recent || []).some((r) => r.id === process.argv[2] && r.host === "claude")) throw new Error("no recent row for " + process.argv[2]);
' "$TMP/workspaces.json" "$SID"
echo "== PR 3's verbs through the Claude Code plugin's launcher (spaces-redesign D27, D17, D18)"
# `which` names the workspace from its folder, and none at the vault root; it writes nothing.
(cd "$WS" && sh "$ROOT/plugin/bin/aos" workspace which --json) | grep -q '"name": "reh-claude"'
(cd "$VAULT" && sh "$ROOT/plugin/bin/aos" workspace which --json) | grep -q '"name": null'
sh "$ROOT/plugin/bin/aos" workspace set reh-claude --set '{"pinned":true}' --expect none --json | grep -q '"written": true'
grep -q '^pinned: true$' "$WS/workspace.md"
sh "$ROOT/plugin/bin/aos" workspace new reh-throwaway --json > /dev/null
sh "$ROOT/plugin/bin/aos" workspace archive reh-throwaway --json | grep -q '"archivedAs": "_archive/reh-throwaway"'
[ -d "$VAULT/workspaces/_archive/reh-throwaway" ] && [ ! -e "$VAULT/workspaces/reh-throwaway" ]
sh "$ROOT/plugin/bin/aos" workspace restore reh-throwaway --json | grep -q '"path": "workspaces/reh-throwaway"'
[ -d "$VAULT/workspaces/reh-throwaway" ]
# The config dir must end as it began: the uninstall leg compares its listing with the one taken at the start.
rm -rf "$CLAUDE_CONFIG_DIR/projects"

echo "== update notice degrades silently and renders a seeded update"
# Nothing has been checked yet: the notice must print nothing and still exit 0.
OUT=$(AOS_NO_SPAWN=1 sh "$AOS" update-notice 2>&1)
[ -z "$OUT" ] || { echo "update-notice printed before any check: $OUT"; exit 1; }

# A seeded store proves the render path without any network call.
# AOS_NO_SPAWN=1 — NOT the timestamp — is the only thing keeping this leg off the network.
# isStale() treats a FUTURE checkedAt as stale by design (clock skew: re-check rather than wait it
# out), so 2099 reads as "maximally fresh" and behaves as "recheck immediately". Dropping
# AOS_NO_SPAWN here would hand this CI gate a dependency on GitHub's uptime.
cat > "$VAULT/brain/_index/update-check.json" <<'JSON'
{ "schema": 1, "checkedAt": "2099-01-01T00:00:00.000Z", "installed": "0.1.0", "vaultVersion": "0.1.0",
  "pluginVersion": "0.1.0", "latest": "9.9.9", "behind": true, "url": null, "snooze": null,
  "lastError": null, "consecutiveFailures": 0 }
JSON
AOS_NO_SPAWN=1 sh "$AOS" update-status --statusline | grep -q '9.9.9' || { echo "no fragment for a seeded update"; exit 1; }
AOS_NO_SPAWN=1 sh "$AOS" update-notice | grep -q '9.9.9 available' || { echo "no session notice for a seeded update"; exit 1; }
grep -q '9.9.9' "$VAULT/brain/_index/update-line.txt" || { echo "update-notice did not re-render the fragment"; exit 1; }

# Leave the vault as the later legs expect: an unseeded store renders nothing.
rm -f "$VAULT/brain/_index/update-check.json" "$VAULT/brain/_index/update-line.txt"

echo "== status line: opt-in install chains the previous line, renders three lines, uninstall restores settings.json"
printf '{\n  "model": "sonnet",\n  "statusLine": {\n    "type": "command",\n    "command": "echo previous"\n  }\n}\n' > "$CLAUDE_CONFIG_DIR/settings.json"
cp "$CLAUDE_CONFIG_DIR/settings.json" "$TMP/settings.before"
sh "$AOS" statusline install | tee "$TMP/statusline.txt"
grep -q '^claude  status line installed in .*; chains the previous line: echo previous$' "$TMP/statusline.txt"
[ -f "$VAULT/brain/_index/statusline.json" ] || { echo "install did not build the model"; exit 1; }
# Run the exact command Claude Code would, from settings.json, with a payload on stdin.
SLCMD=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).statusLine.command)' "$CLAUDE_CONFIG_DIR/settings.json")
echo "{\"session_id\":\"reh\",\"model\":{\"display_name\":\"Claude\"},\"workspace\":{\"current_dir\":\"$VAULT\"},\"context_window\":{\"remaining_percentage\":80}}" \
  | AOS_NO_SPAWN=1 COLUMNS=160 sh -c "$SLCMD" > "$TMP/render.txt"
grep -q 'Claude' "$TMP/render.txt" || { echo "render printed: $(cat "$TMP/render.txt")"; exit 1; }
grep -q '%' "$TMP/render.txt" || { echo "render has no context meter: $(cat "$TMP/render.txt")"; exit 1; }
[ "$(sh "$AOS" statusline preview --width 160 | wc -l)" -ge 2 ] || { echo "preview printed under two lines"; exit 1; }
sh "$AOS" statusline status | grep -q '^claude  installed in .* · chains echo previous'
sh "$AOS" statusline uninstall | grep -q '^claude  removed; restored echo previous$'
cmp -s "$CLAUDE_CONFIG_DIR/settings.json" "$TMP/settings.before" || { echo "settings.json was not restored byte for byte"; exit 1; }
echo '{}' > "$CLAUDE_CONFIG_DIR/settings.json"

echo "== doctor"
# doctor's "plugin installed" check reads fake-claude's `plugin list --json`, which lists the plugin only while
# FAKE_PLUGIN_PATH is set — so it is exported here, after init has already exercised the install path.
export FAKE_PLUGIN_PATH="$ROOT/plugin"
node "$ROOT/cli/aos.js" doctor | tee "$TMP/doctor.txt"
grep -Eq '^ok +uv installed ' "$TMP/doctor.txt" && grep -Eq '^ok +graphify [0-9.]+ ' "$TMP/doctor.txt" && grep -Eq '^ok +graph fresh ' "$TMP/doctor.txt"

echo "== uninstall --keep-vault restores the config dir"
node "$ROOT/cli/aos.js" uninstall --keep-vault --yes
AFTER=$(ls -A "$CLAUDE_CONFIG_DIR" | sort)
[ "$BEFORE" = "$AFTER" ] || { echo "config dir changed: $AFTER"; exit 1; }
[ -f "$VAULT/MEMORY.md" ]
[ ! -e "$HOME/.local/bin/aos" ]
[ ! -e "$HOME/.local/share/agenticos/graphify" ] || { echo "graphify tool dir left behind"; exit 1; }
echo REHEARSAL-OK
