# Codex plugin — one repo, a Claude Code plugin and a Codex plugin — design

Date: 2026-09-23 · Branch: `feat/codex-plugin` · Verified against `6b372c5` (0.9.2) and Codex CLI 0.155.1

## 1. Problem

Under Claude Code the Workbench is a plugin: `claude plugin marketplace add` + `claude plugin install`, and
`claude plugin update` moves it forward. Under Codex it is not. `aos init --host codex` writes into the user's
own Codex config (`cli/codex-host.js`): five hook events merged into `~/.codex/hooks.json`, a `codex mcp add`
registration, and 21 generated skills under `~/.agents/skills/`. The codex-compat design (D3) chose that on
purpose because Codex's plugin format was behind a feature flag and `${CLAUDE_PLUGIN_ROOT}` expansion in a
plugin's `.mcp.json` was unverified; codex-parity §6 listed "a Codex plugin bundle" as out of scope.

Codex 0.155 now ships plugins as a stable feature (`codex plugin add|list|remove`, `codex plugin marketplace
add owner/repo`), with hooks, MCP servers and skills inside a plugin. The owner wants the Workbench installable
as a Codex plugin as well as a Claude Code plugin, from the same repository.

## 2. What a spike against Codex 0.155.1 showed (sandboxed `HOME`/`CODEX_HOME`, throwaway probe plugin)

| Question | Result |
|---|---|
| Does Codex read Claude manifests? | Yes: `.codex-plugin/`, then `.claude-plugin/`, then `.cursor-plugin/plugin.json`; marketplaces `.agents/plugins/marketplace.json`, then `.claude-plugin/marketplace.json`. The unmodified `plugin/` installs as `agenticos@agenticos-workbench`. |
| …and does it work unmodified? | No. Only 4 of 17 commands are migrated (as `agenticos:source-command-<name>`, no rewrites); the MCP server never starts because `${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_ROOT}` are **not** expanded in MCP args; hooks run without `AOS_HOST` and without `inject-conventions`. |
| Hook commands | `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` **are** expanded (to the versioned cache dir). SessionEnd timeouts are clamped to 3 s. Plugin hooks are untrusted until reviewed once under `/hooks`. |
| Trust across upgrades | Trust key is `<plugin>@<marketplace>:<relative hooks path>:<event>:<group>:<index>`; `currentHash` was identical across a version-only bump although the expanded path changed, so it hashes the raw command and trust survives `aos upgrade`. |
| MCP | `{"mcpServers": {…}}` with `"command": "sh", "args": ["./bin/aos", …], "cwd": "."` spawns in the installed plugin root with the declared `env` intact. |
| Skills | Listed to the model as `agenticos:<name>` (the same prefix Claude Code uses). Bodies are read raw from disk; nothing is substituted. |
| Manifest path pointers | On 0.155.1 `skills`/`hooks`/`mcpServers` pointers **replace** the default locations, but Codex's own `plugin-json-spec.md` documents them as **supplementing** defaults. `commands/` is migrated unless a `commands` pointer names an empty folder. |
| Two marketplace files in one repo | Codex installs from `.agents/plugins/marketplace.json`; Claude Code only reads `.claude-plugin/marketplace.json`. Same marketplace name, a different folder per host. |

## 3. Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | A **separate `codex-plugin/` folder** in Codex's default layout (`.codex-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `skills/`, `bin/aos`), listed by a new `.agents/plugins/marketplace.json` (marketplace `agenticos-workbench`, plugin `agenticos`, source `./codex-plugin`). `plugin/` and `.claude-plugin/` are untouched. | (a) Let Codex install `plugin/` as-is. (b) Add `.codex-plugin/plugin.json` inside `plugin/` with path pointers to Codex-only files. | (a) is lossy and the MCP server never starts (§2). (b) works on 0.155.1 only because pointers replace defaults today; if Codex ships its documented "supplement" behaviour, the Claude hooks and the broken `.mcp.json` would load under Codex too. A folder that uses only default locations does not depend on either reading. |
| D2 | `codex-plugin/` is **generated and committed**: `tools/build-codex-plugin.js` (`npm run build:codex-plugin`) builds it from `plugin/` and `cli/codex-host.js` (the `HOOKS` table and the skill transforms); a test fails when the committed tree differs from a fresh build. | Hand-maintain a second copy; or build at install time. | A copy drifts silently. A marketplace install copies files and runs nothing, so the output must already be in the repo. One generator keeps both hosts in lockstep with `plugin/`. |
| D3 | **No absolute path in the plugin.** Hooks: `env AOS_HOST=codex sh "${PLUGIN_ROOT}/bin/aos" <name>` (the same 15 entries as `HOOKS`, `inject-conventions` included). MCP: `sh ./bin/aos mcp-server`, `cwd: "."`, `env: {AOS_HOST: codex}`, `env_vars: [AOS_CONFIG, CLAUDE_CONFIG_DIR]`. Skills call `sh "<plugin root>/bin/aos"`, where the host note defines `<plugin root>` as two folders above the skill's folder. Config is found the way the launcher already finds it (`AOS_CONFIG`, else `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`). | Bake `AOS_CONFIG` and the vault launcher into the plugin, as direct wiring does. | A published plugin cannot know a user's paths. Every form above was verified to spawn or expand in §2; `AOS_HOST=codex` stays authoritative in `lib/host.js` whatever else is in the environment. |
| D4 | `aos init --host codex\|both` **installs the plugin** (`codex plugin marketplace add <repo \| --from-local dir>`, `codex plugin add agenticos@agenticos-workbench`) when `codex plugin list --json` succeeds; otherwise it falls back to today's direct wiring. The mode is recorded as `hosts.codex.install: "plugin" \| "direct"`. `aos upgrade` refreshes the plugin (`codex plugin marketplace upgrade agenticos-workbench` for a git source, then `codex plugin add` again). | Make the plugin opt-in; or drop direct wiring. | The plugin is the host's own install and update path, like Claude Code's. Keeping direct wiring as the fallback costs no new code and keeps older Codex builds working. |
| D5 | **Never both.** When the plugin is installed, init and upgrade remove any direct wiring with the same steps as `removeCodexHost` (strip our hook entries, `codex mcp remove agenticos` — which never touches a plugin's server — and delete marker-carrying skills). An existing install migrates on its next `aos upgrade`, which prints the `/hooks` instruction. | Leave direct wiring beside the plugin. | Side by side means every hook fires twice, two MCP servers are named `agenticos`, and `$wrap` sits next to `$agenticos:wrap`. The cost is one more `/hooks` review (the trust key moves from `~/.codex/hooks.json:…` to `agenticos@agenticos-workbench:hooks/hooks.json:…`); after that, upgrades keep trust (§2). |
| D6 | `aos doctor` in plugin mode shows `codex plugin` (from `plugin list --json`), `codex hooks trusted` (our keys under `[hooks.state]` in `config.toml`, n of 15; warn → "open codex, run /hooks") and `codex MCP declared` (`codex mcp list --json` names `agenticos` with `./bin/aos`), plus a `codex direct wiring` warn row when direct wiring is still present. | Query hook trust through `codex app-server` (`hooks/list`). | The JSON-RPC route gives an exact `trustStatus` but spawns an app server from doctor; counting trusted keys in `config.toml` is a file read and says the same thing unless a hook command changes, which is exactly when Codex asks again anyway. |
| D7 | `codex-plugin/.codex-plugin/plugin.json` joins the **version surfaces** in `tools/bump-version.js` (write and `--check`); the Codex marketplace entry carries no version. | Leave the version to the generator only. | `release.yml` runs `bump-version --check` against the tag; the Codex plugin version must be checked there like the Claude one. |

## 4. What already exists (at `6b372c5`)

- `cli/codex-host.js`: `HOOKS` (event → names, timeouts), `rewriteBody`, `commandToSkill`, `skillToCodex`,
  `generateSkills`, `installCodexHost` / `removeCodexHost` / `codexHostStatus`, `run` seam, `codexBin`.
- `plugin/bin/aos` (95 lines): the launcher; exits 0 when uninitialized, so a hook never fails a session.
- `cli/aos.js`: `installPlugin` (Claude marketplace flow, `--from-local`), init step 6b, upgrade re-wire at
  the `hosts.codex` branch, `uninstall --host codex`, doctor's Codex block, `buildUserConfig` (the `hosts` block).
- `cli/plugin-manifests.test.js` (hooks.json ↔ `HOOKS` ↔ `bin/aos`), `cli/codex-host.test.js`,
  `cli/fixtures/fake-codex.sh`, `cli/rehearsal/codex-host.sh`, `tools/bump-version.js` + test.
- `brain/scripts/lib/host.js` `resolveHost`: `AOS_HOST` first, so the plugin needs no runtime change.

## 5. Design

### 5.1 Layout (generated)
```
.agents/plugins/marketplace.json      name agenticos-workbench · plugins[agenticos] → ./codex-plugin
codex-plugin/.codex-plugin/plugin.json name, version, description, author, homepage, repository, license,
                                       keywords, skills ./skills/, hooks ./hooks/hooks.json, mcpServers
                                       ./.mcp.json, interface {displayName, shortDescription, longDescription,
                                       developerName, category, capabilities, websiteURL, defaultPrompt}
codex-plugin/hooks/hooks.json         from HOOKS, commands per D3
codex-plugin/.mcp.json                per D3
codex-plugin/bin/aos                  byte copy of plugin/bin/aos (mode 0755)
codex-plugin/skills/<name>/…          17 commands + 6 skills → 21 skills (cost and wrap merge, as today)
```

### 5.2 Skill transform
`rewriteBody` gains a `target` of `direct` (today, unchanged output) or `plugin`. Plugin target:
`sh "${CLAUDE_PLUGIN_ROOT}/bin/aos"` → `sh "<plugin root>/bin/aos"`; `${CLAUDE_PLUGIN_ROOT}/skills/` →
`<plugin root>/skills/`; the config expression is left as written; `/name` → `$agenticos:name`;
`mcp__plugin_agenticos_agenticos__` → `mcp__agenticos__`. The marker line reads "generated by
tools/build-codex-plugin.js from plugin/; edit the source".

### 5.3 Installer (`cli/codex-host.js`, `cli/aos.js`)
New `codexPluginSupported`, `installCodexPlugin({ bin, source, run })`, `upgradeCodexPlugin`,
`removeCodexPlugin`, `codexPluginStatus` (installed, version, trusted n/15, MCP, leftover direct wiring).
Init step 6b and the upgrade branch pick the mode per D4, then run D5's clean-up. `uninstall --host codex`
removes the plugin and the marketplace, then any direct leftovers.

## 6. Testing

- `tools/build-codex-plugin.test.js`: committed tree equals a fresh build; no absolute paths; 21 skills, each
  with `name` and `description`; no `${CLAUDE_PLUGIN_ROOT}` left in a skill.
- `cli/plugin-manifests.test.js`: `.agents/plugins/marketplace.json` shape; Codex manifest version equals
  `package.json`; Codex hooks mirror `HOOKS` with `AOS_HOST=codex`; `codex-plugin/bin/aos` equals `plugin/bin/aos`.
- `cli/codex-host.test.js`: plugin argv for install, upgrade (git and local), remove; mode fallback; migration
  removes direct wiring; trust counting from a fixture `config.toml`. `fake-codex.sh` learns `plugin` and `mcp list`.
- `cli/rehearsal/codex-host.sh`: a plugin-mode leg (fake codex).
- Real Codex, sandboxed like the spike: install from the branch; `hooks/list` shows 15 hooks with `AOS_HOST=codex`;
  `mcp list` shows `agenticos` in the plugin root; the model sees 21 `agenticos:*` skills and no `source-command-*`.
- Manual on this machine after merge: `aos upgrade --from-local` migrates, `/hooks` trust once, one real Codex
  session produces a `host: codex` run; confirm the MCP tool names are `mcp__agenticos__*` under a plugin.

## 7. Out of scope

- Listing in a curated Codex plugin directory; plugin `apps`; icons and screenshots in `interface`.
- Any change to `plugin/` (the Claude Code plugin) or to the runtime under `brain/scripts/`.
- Removing direct wiring from the codebase (it stays as the fallback, D4).
- Windows.
