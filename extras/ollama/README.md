# extras/ollama

Optional supervisors and helpers for the local Ollama (recommended, not required: `aos init` warns when it is missing, and background work waits for it). The Ollama app keeps its own server running; these are for a bare `ollama` CLI.
Nothing here is installed by `aos init`; the product's hooks and MCP server never call these files.

| File | What it is |
|---|---|
| `ollama-serve.sh` | Keeps `ollama serve` alive on 127.0.0.1:11434 (POSIX sh; run it under the launchd or systemd template below so a crash is a restart). Logs to `~/.local/state/agenticos/ollama-serve.log` (`AOS_OLLAMA_LOG`). |
| `model-pull.sh` | Pulls the two default tags in order (`ollama pull`, stops at the first failure). `model-pull.sh --list` prints the tags one per line without needing Ollama. Honors `BRAIN_MODEL` / `BRAIN_EMBEDDER`. |
| `launchd/com.agenticos.ollama.plist.tmpl` | macOS supervisor for `ollama-serve.sh` (`KeepAlive`, `RunAtLoad`). Placeholders `{{EXTRAS}}`, `{{HOME}}`. |
| `systemd/agenticos-ollama.service.tmpl` | Linux user unit for `ollama-serve.sh` (`Restart=always`). Placeholder `{{EXTRAS}}`. |
| `wrap-headless.js` | Autonomous session wrap (mechanical wrap + local narrative summary). The product's SessionEnd hook (`auto-wrap`) supersedes it; kept for scripted use. |

`wrap-headless.js` loads the brain runtime from `../../brain/scripts` and resolves the
vault the same way every script does (`AOS_VAULT`, then `agenticos.json`). It talks to
Ollama directly and does not consult the provider setting.

Models: under provider `local` (a new install's default) the workhorse follows the Mac's memory, `qwen3.5:4b` under
12 GB, else `qwen3.5:9b` (`local.model` names another), with `qwen3-embedding:0.6b` as the embedder; `aos local pull`
downloads them. `model-pull.sh` pulls the two default tags, `qwen3.5:9b` and `qwen3-embedding:0.6b` (override with
`BRAIN_MODEL` and `BRAIN_EMBEDDER`). The reasoner role (`/ask-brain --local`, `/reflect-week`, `/consolidate-memory`,
Vault chat) is a hosted model, not one of these tags, except under provider `local`, where each follows its `ai.*`
switch and runs on the local model by default.
It runs on Claude (`reasoner.model`, default `claude-opus-5`) through your Claude Code login, or
on Codex (`reasoner.codexModel`) when Codex is a host and logged in; Claude comes first unless
`provider` is `codex`. Only when neither host is available, or the reasoner's daily cap is
reached, and Ollama is up does the call fall back to the workhorse here. See docs/install.md,
"The reasoner role".

## Keeping Ollama alive

Neither template is installed by `aos init` nor removed by `aos uninstall`; render and
load it by hand from the repo root, and remove it the same way.

macOS (launchd):
```sh
EXTRAS="$(pwd)/extras/ollama"
mkdir -p ~/Library/LaunchAgents ~/.local/state/agenticos
sed "s#{{EXTRAS}}#$EXTRAS#g; s#{{HOME}}#$HOME#g" "$EXTRAS/launchd/com.agenticos.ollama.plist.tmpl" \
  > ~/Library/LaunchAgents/com.agenticos.ollama.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agenticos.ollama.plist
# remove: launchctl bootout "gui/$(id -u)/com.agenticos.ollama" && rm ~/Library/LaunchAgents/com.agenticos.ollama.plist
```

Linux (systemd user unit):
```sh
EXTRAS="$(pwd)/extras/ollama"
mkdir -p ~/.config/systemd/user ~/.local/state/agenticos
sed "s#{{EXTRAS}}#$EXTRAS#g" "$EXTRAS/systemd/agenticos-ollama.service.tmpl" \
  > ~/.config/systemd/user/agenticos-ollama.service
systemctl --user daemon-reload && systemctl --user enable --now agenticos-ollama.service
# remove: systemctl --user disable --now agenticos-ollama.service && rm ~/.config/systemd/user/agenticos-ollama.service
```

Tests: `node --test extras/ollama/*.test.js` (not part of `npm test`; the glob form — Node ≥22 rejects `node --test <dir>`).
