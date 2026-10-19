# Phase 4: sandbox the renderer — plan

Design: `docs/design/specs/2026-10-05-workbench-app-design.md` (D6, D7). Parent plan:
`docs/design/plans/2026-10-05-workbench-app.md` (phase 4). Verified against `64150bc`.

## Where it starts

The app runs the HUD with Node in the renderer (`nodeIntegration: true`, `contextIsolation: false`, `sandbox: false`).
esbuild answers the HUD's `fs` and `child_process` imports with guard shims (`app/src/renderer/guard/*.cjs`) that ask
the write policy (`app/src/shared/write-policy.ts`) before a write or a spawn. That is a fence for the HUD's own code:
an injected script in the page would `require` the real modules. The HUD's Node surface, measured:

| What | Where |
|---|---|
| `fs` (sync reads, two tail readers, a few writes) | 19 modules: `main.ts`, `data/{agents,aosConfig,claudeAsk,commandRegistry,externalSchedules,hostRoutines,inventory,liveRuns,nodeResolver,routines,runDetail,skills,staff,teams,terminalInstall,workspaceFiles}`, `ui/pluginSettingRows`, `views/PulseTab` |
| `child_process` | 7: `main.ts`, `data/{aosRun,askSpawner,claudeAsk,commandRegistry,nodeResolver,terminalInstall}` |
| node-pty | `data/terminalSession.ts` (a computed `require`) |
| `os`, `process.env/platform/versions/cwd`, `Buffer` | 8 + 12 modules; six env variables (`CLAUDE_CONFIG_DIR`, `AOS_CONFIG`, `AOS_VAULT`, `CODEX_HOME`, `SHELL`, `HOME`) |
| `require("electron").shell` | 7 views: `openPath` (folders, a proposal's page, a skill or agent file) |
| `path` | 27 modules (pure; needs no host) |

The compat layer (`app/obsidian-compat/src/{vault,plugin,noteEditor,workspace,index}.ts`) reads and writes with `node:fs` too.

## Decisions (under D7)

| # | Decision | Rejected |
|---|---|---|
| S1 | **The seam is `hud/src/host.ts`**: a `HudHost` (fs subset, spawn, a sync exec, pty, shell, env) with `setHudHost()`. Modules import `fs`, `spawn`, `env` from it; the call sites keep Node's names and signatures. `src/nodeHost.ts` is the only HUD file that imports Node, node-pty or electron: the default for node:test and Obsidian. A test fails if any other HUD file imports them | Injecting a host into every function: hundreds of signatures change for no gain over one module-level seam |
| S2 | **Reads are synchronous IPC** (`ipcRenderer.sendSync`): the HUD reads inside render paths. Writes are synchronous too (small files); Trash is async. The vault index is one bulk `walk`, and the compat `Vault` keeps the stats it walked, so `getFiles()` is no longer a stat per file | Making every HUD read async: a rewrite of 19 modules and the views that call them |
| S3 | **Main is the policy.** `WritePolicy` moves to main; the surface table becomes import-free data the renderer can show. Every fs call is checked in main against a read scope (vault, the Claude and Codex folders `agenticos.json` and the environment name, `~/.agents`, LaunchAgents and `/etc/shells` read-only, the app's own plugin data) and the write policy | Keeping the checks in the renderer: an injected script would skip them |
| S4 | **Programs are resolved in main.** A spawn's program is a bare name (main's PATH) or an absolute executable outside the vault and the app's data; node runs only `<vault>/brain/scripts/…`; the child's environment is main's plus an allow-listed set of variables (no `NODE_OPTIONS`, no `PATH`). The renderer names ids for its children and pty sessions; main caps how many run | Trusting the renderer's `env` and binary paths: `NODE_OPTIONS` or a `node` of its choosing would run anything |
| S5 | **The pty lives in main** (the app's own node-pty). Sessions start a shell from `/etc/shells` with no arguments; data streams as events. The Terminal tab is a shell by design: SECURITY.md records it as the residual risk the sandbox cannot remove | Keeping node-pty in the renderer: impossible with `sandbox: true` |
| S6 | **`shell.openPath` opens folders and document types only** (md, txt, json, jsonl, csv, yaml, pdf, images; html and svg only from `brain/_index`, the runtime's proposal pages) and shows anything else in Finder; `openExternal` takes `https:` only (the `obsidian://` entry goes) | Any path: a `.terminal` or `.command` file written into the vault would run on open |
| S7 | **Files and Notes never write a dot-path** (`**/.*`, `**/.*/**`). The Files tree and the index already hide them; this keeps a compromised page from planting `.claude/settings.json` hooks, `.mcp.json` or `.codex/` config in the vault | Listing each host's config file: the list would drift |
| S8 | **Packaged builds refuse `--remote-debugging-*`, `--inspect*` and `--js-flags`** at the top of main, before Chromium starts its DevTools server. `npm run dist:test` builds an ad-hoc-signed smoke build (`AOS_APP_TEST_BUILD=1`, its own `dist-test/`) that accepts them; `smoke:packaged` drives that build, and `dist:verify` checks that the release build exits on the flag | An environment switch in the release build: whoever can launch the app with a variable set could also borrow its permissions through the debugger |
| S9 | **The preload exposes named functions only** (`window.aos`), built from an import-free contract; zod schemas and sender checks live in main. Refusals come back as results; the renderer records them in the guard log the e2e suite reads | A generic `invoke(channel)`: hands the page every channel |

## The IPC contract (`app/src/shared/ipc.ts`)

| Area | Calls (S = sync, A = async) | Events |
|---|---|---|
| `host` | `boot` S · `ready` (send) | `host:command`, `host:protocol`, `vault:changes` |
| `fs` | `exists` `stat` `readText` `readBytes` `readdir` `walk` S · `writeText` `appendText` `mkdir` `remove` `rename` `copy` S · `trash` A | — |
| `proc` | `spawn` (send, renderer id) · `kill` (send) · `execSync` S | `proc:event` {id, stdout · stderr · error · exit} |
| `pty` | `spawn` A · `write` `resize` `kill` (send) | `pty:event` {id, data · exit} |
| `shell` | `openExternal` (send) · `openPath` A · `showItemInFolder` (send) | — |
| `plugin` | `loadData` S · `saveData` S (`<userData>/plugins/<id>.json` only) | — |

Every handler: sender is the main window's main frame on `app://hud`; arguments parsed by a zod schema typed against
the contract; a `Result` back, never a thrown error. Paths are absolute, NUL-free, at most 4096 bytes; texts at most 32 MB.

## Files

| Path | What |
|---|---|
| `hud/src/host.ts`, `src/nodeHost.ts`, `src/host.test.ts` | the seam, the Node host, the import tripwire |
| `hud/{main.ts,src/**}` | the 19 + 7 modules and 7 views through the seam; `Buffer` → `TextDecoder` |
| `app/src/shared/ipc.ts` | the contract (no imports) |
| `app/src/shared/surfaces.ts` | the surface table and globs, import-free (renderer and main) |
| `app/src/main/policy/{write-policy,read-scope,programs}.ts` | the write policy (moved), the read scope, program and env rules |
| `app/src/main/ipc/{trust,schemas,fs,proc,pty,shell,host}.ts` | handlers |
| `app/src/preload/index.ts` | `contextBridge.exposeInMainWorld("aos", …)` |
| `app/src/renderer/bridgeHost.ts`, `renderer/shims/path.ts` | the HudHost over `window.aos`; POSIX `path` for the bundle |
| `app/obsidian-compat/src/*` | the vault, plugin data, note editor and Finder through the host; guard log kept for refusals |
| `app/scripts/{build,smoke-packaged,verify-dist}.mjs`, `package.json` | preload bundle, HUD import errors, `dist:test`, the refusal check |
| `app/tests/unit/*`, `app/tests/e2e/sandbox.spec.ts` | policy, schemas, path shim, bridge host; the page has no Node and the bridge refuses |
| `SECURITY.md` | the review (dev-electron-hardening checklist), residual risks |

`app/src/renderer/guard/` and the guard shims go: nothing in the renderer can reach Node any more.

## Tasks

- [x] HUD seam, Node host, modules through it; `npm test -w hud` green, tripwire test.
- [x] Main policy modules and handlers with unit tests (scope, programs, env, schemas, refusals).
- [x] Preload, bridge host, compat on the host, build (preload bundle, `path` shim, HUD Node imports are build errors).
- [x] `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; debug switches refused when packaged.
- [x] e2e green sandboxed, plus `sandbox.spec.ts`; harden `teams-writes.spec.ts:69` and `notes-writes.spec.ts:178`.
- [x] `dist:test` + smoke, `dist:verify` refusal check; SECURITY.md; CHANGELOG.

**Exit:** app e2e green with the renderer sandboxed; SECURITY.md with no open high finding. The independent review's
two medium findings (a folder removed with the runtime's folders in it; credential files refused by name only) were
fixed before the PR: a folder only goes to the Trash and never holds `brain/_index` or `brain/scripts`, and the page
reads only what it shows of the hosts' folders.
