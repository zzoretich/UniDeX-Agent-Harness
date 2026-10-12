# Security

## Reporting a vulnerability

Please do not put the details of a vulnerability in a public issue. Open an issue titled "Security contact", with no
details, and the maintainer will reply with a private way to send the report.

AgenticOS runs on your own Mac, with your own permissions: the runtime and its hooks run as you, the AgenticOS
Workbench app reads and writes your vault, and the agents it starts (Claude Code, Codex) act as you within their own
permission settings. What follows is how the app keeps what it displays from becoming what it runs.

## The app: how it is built to be safe

The Workbench shows text it did not write: notes, proposals, notifications whose stories come from the web, and agents'
output. The design treats the page that shows them as untrusted (design D7,
`docs/superpowers/specs/2026-10-05-workbench-app-design.md`; plan `docs/superpowers/plans/2026-10-05-sandbox-renderer.md`).

- **Nothing in the page can run code it was handed.** The page loads only the app's own files from `app://hud`, under a
  Content Security Policy that allows only those scripts (`script-src 'self'`, no inline script, no `eval`). Markdown is
  rendered with raw HTML off and sanitized by DOMPurify. Its two typefaces (Inter and JetBrains Mono, OFL) are copied
  into the app at build time from pinned packages, so the page fetches no fonts (`font-src 'self'`).
- **The page has no access to your Mac.** It runs in Chromium's sandbox with context isolation and no Node. Its only way
  out is `window.aos`, a short list of named functions (`app/src/preload/index.ts`). Main answers only the main window's
  own page, checks every argument against a schema, and answers each call with a result rather than an error.
- **Main decides every call** (`app/src/main/policy/`):
  - *Reads:* the vault, `~/.agents`, `~/Library/LaunchAgents`, `/etc/shells`, the app's own data, and of the Claude
    Code and Codex folders that `agenticos.json` and the environment name only what the Workbench shows:
    `agenticos.json`, skills, agents, commands and prompts. The session folders may be listed, to find out whether a
    transcript exists, but no transcript is read. Never a credential file (`auth.json`, `.credentials.json`, `.env`,
    keys), wherever it is. Whether a program exists may be asked by its well-known name (`node`, `claude`, a shell)
    anywhere, for the pickers that look for them.
  - *Writes:* only what a Workbench surface writes (`app/src/shared/surfaces.ts`): To-Do writes `TODO.md`, Capture writes
    memories, and so on. Files and the note editor write anywhere in the vault except the runtime's folders
    (`brain/_index`, `brain/scripts`), dependency folders and every dot-path, so no page can plant a host's project
    configuration (`.claude/settings.json` hooks, `.mcp.json`, `.codex/`, `.git/hooks`). The page cannot create links or
    change a file's permissions. Spaces and Brain write no file themselves; their verbs write as their rows under
    *What the design accepts* say.
  - *Processes:* only the runtime's own commands, each with an argument rule (a background refresh, or a command of a
    surface that is on), never through a shell. The program is a bare name main finds on its own `PATH`, or an
    executable outside the vault and the app's data, which the page cannot create. The child's environment is main's,
    plus a few named variables with fixed or trusted values: never `NODE_OPTIONS`, `PATH` or `DYLD_*`, and a Claude
    or Codex folder only when it is one main trusts.
  - *Terminals:* a shell listed in `/etc/shells` (or your `$SHELL`), with no arguments. Main starts it with its own
    environment, `PATH` replaced by your login shell's (asked once, as the setup wizard does) and `CLAUDECODE` removed;
    the page still cannot set `PATH`. The Code tab starts an agent by typing its command into that shell. Spaces types
    a Resume line only with a UUID from the scan, and a Clone line only for a URL matching the GitHub rule (a
    `https://github.com/<owner>/<repo>` URL or GitHub's SSH form of it, quoted).
  - *Appearance:* the page may set the theme to `system`, `light` or `dark` and nothing else; main saves the choice in
    the app's data (`app-settings.json`), never in the vault, and hands it to macOS's `nativeTheme`.
  - *Setup (phase 5):* the wizard names a fix by id; main runs that fix's fixed command (`app/src/main/policy/setup.ts`:
    Homebrew's installer, `brew install …`, `npm install -g` for the two CLIs, the two logins) with `/bin/sh -c` in a
    terminal the wizard shows, and only once its own checks say what it needs is there. `aos init` and `aos upgrade`
    are the bundled runtime's CLI, run with the `node` main found, never through a shell and with no stdin. The
    persona answers are checked against the interview's rules, written to the app's data folder (mode 0600) and
    removed when `aos init` ends. The `CLAUDE.md` line and file are main's to compute; the line is appended only when
    the page asks, for a Claude Code install. Install runs only with no vault attached, upgrade only when the app's
    runtime is newer than the vault's, and one job runs at a time.
  - *The OS:* links open in the browser over https only. A document or a folder opens with its app; a file that would
    run when opened (a script, a `.terminal` or `.command` file, an app or other bundle), or a web page anywhere but the
    runtime's own proposal pages, is shown in Finder instead. A folder is never deleted for good: it goes to the
    Trash, and the runtime's folders (`brain/_index`, `brain/scripts`) are never moved, trashed or removed.
- **Packaged builds cannot be driven from outside.** The fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and
  `--inspect`, and the archive is integrity-checked. Chromium's remote debugging has no fuse, so a release build refuses
  to start with `--remote-debugging-*`, `--inspect*` or `--js-flags` (`app/src/main/policy/debug.ts`;
  `npm run dist:verify` checks it). Releases are signed with a Developer ID under the hardened runtime and notarized.
- **Updates come only from this repo's releases, signed like the app.** electron-updater reads `latest-mac.yml` from the
  latest GitHub release and downloads the zip it names over https, checking its sha512; Squirrel.Mac then installs it
  only if its code signature satisfies the running app's designated requirement (same Developer ID team). A dev run
  and the smoke build never update; `updates.check: false` turns updates off.

## What the design accepts

| Risk | Why it stays | What limits it |
|---|---|---|
| The Code tab is a shell | It is the feature: what you type runs as you. A compromised page could type into a terminal it opens | Nothing in the page can run code (CSP, sanitized Markdown, no remote content), so a page must first be compromised; the terminal starts only a listed shell |
| The page can do what the Workbench's buttons do | Routines run agent prompts, Settings changes settings, Agent Teams approves gates | Each is a named command with an argument rule; nothing outside the surfaces runs |
| The page can make the Chief of Staff write a briefing now | Pulse's ↻ (spec 2026-10-08-pulse-cockpit-design P13) | One rule on the Pulse surface: `persona/briefing.js --force` and nothing else. It makes one model call through `provider.js`, under the daily duty cap (`persona.perDayUsd`), and writes only `brain/_index/briefing.json`; nothing runs while the persona is off |
| The page can create, move and rename workspaces and set workspace.md fields | Spaces' New, Adopt, Archive, Restore, Rename, Pin and Set status (spec 2026-10-09-spaces-redesign D15–D18) | Named `aos workspace` verbs, each with an argument rule; the runtime checks every name and path, writes only `workspaces/**` and `brain/_index/**` plus a project note's status tag, moves folders only between `workspaces/` and `workspaces/_archive/`, deletes nothing, follows no symlink, refuses a linked `workspaces/`, `workspaces/_archive`, map, thread or project-note folder (each must be a plain folder inside the vault), never writes a map over another, matches a name to its folder exactly, refuses headless runs, and asks before every move. On by default since 1.7.0, after a live check on each host |
| The page can mark memories reviewed, pin them, change their status, archive, restore and supersede them, approve or reject feedback drafts, fix what Health's hygiene check finds, and preview recall | The Brain tab's Review, Library, Bootstrap and Health (spec 2026-10-11-brain-hub D3–D7, D13, D14, D17, D18, D20) | Named `aos memory` verbs on the `brain` surface, each with an argument rule: a memory path is `brain/memory/<user\|feedback\|projects\|reference>/<slug>.md` (no sub-folder, no `..`, no dash first), 1 to 50 per call, `--json` last; `set` is compare-and-set on the hash the page read (`--expect`) and takes only `pin`, `status` (active, complete, paused) or a one-line `description`, and `--skip-brain-md` (Bootstrap's bulk Mark complete then runs `build-brain-md.js`, with no argument, once); a draft is a plain slug; `fix` takes one kind (`sources`, `types`, `descriptions`, `index`, `drafts`) and nothing else but `--dry-run` or `--expect` with a dry run's 32-character hash. The runtime (`lib/memory-ops.js`) checks each path again, opens it as a regular file (`O_NOFOLLOW`) inside plain vault folders, rewrites only its own frontmatter lines, `MEMORY.md`, the trail and `brain/_index/**` (BRAIN.md through `build-brain-md.js`), atomically and under locks. A hygiene fix (`lib/memory-fix.js`) re-reads the files and changes only live memories (never archived or superseded ones), keeping every other byte: `sources` their `source:` line (`session`, `in-session` or `wrap` becomes `manual-wrap`); `types` their `type:` line (`type: memory`) and `tags:` line (the `memory/<type>` tag; no status is added); `descriptions` a new `description:` line copied from the memory's own `MEMORY.md` line (one line, control characters out, at most 200 characters, quoted when YAML needs it: double quotes, else single quotes with `'` doubled, so strict YAML reads the same text); `index` `MEMORY.md` lines, under its lock (a missing line added under its type's heading, a misfiled line moved unchanged, and a line removed only when nothing at all is at its path, when its memory is archived or superseded, or when it is a second copy of a line its memory keeps, each removal named with its reason; a linked `MEMORY.md` is refused); `drafts` removes an approved feedback draft left behind, one with the slug and the title of a live feedback memory (a regular file read `O_NOFOLLOW` in a plain folder; a new rule that only shares the slug is kept). The page runs each fix with `--dry-run` first, which writes nothing (no file, no trail row), lists every change with the changes' hash, and asks in a confirm; the real run gets that hash (`--expect`) and refuses, writing nothing, unless the files still give exactly the changes listed. It logs a `fixed` trail row per changed memory or draft, and one per memory whose `MEMORY.md` lines it removes, naming each field's before and after (Restore does not undo a fix). Nothing is deleted but a feedback draft that is approved (it moves into the store) or rejected (as `feedback-review` does today), and an approved draft's leftover file (`fix drafts`); archiving and superseding tag a memory in place and Restore undoes both. Archive of more than one memory, a draft's Reject, "Mark everything before", Bootstrap's "Mark the N complete" and every fix ask first. Bootstrap's recall preview runs `sdk/recall-cli.js <query> --limit N --json`: the typed text as one argument that is never a flag (no leading dash, so never `--warm`), with no control or line-separator characters and at most 200 characters, and a one- or two-digit limit. It reads the recall index and writes nothing but a missing one (rebuilt as `aos recall --warm` would: `brain/_index/recall-index.json` and `recall-wake.md`), logs no usage (D9), and calls no model, except that with an embed index it asks the local Ollama (the configured address, under the `auto` or `ollama` provider only) to embed the query: it never resolves the provider, so it writes no `provider-state.json` and runs no headless login probe, and with Ollama down the hits are BM25's. `brain-hub.js` (the hub's caches, `brain/_index/brain-hub.json` and `brain-map.json` only, the map read from graphify's `graph.json`) runs after an action, from Health's Rescan, and when the tab is shown with memories the cache does not hold yet. Pulse no longer writes memory: its trail keep, edit and revert (revert deleted the file) gave way to these verbs. On by default, after a live check on each host's memories |
| The page can make one model call to draft a workspace's `workspace.md` | Spaces' Draft (spec 2026-10-09-spaces-redesign D13, D14) | One rule: `aos workspace draft <name> --json`, which writes no workspace file. It makes one `provider.js` call under the hook cap (`claude.perDayUsd` or `codex.perDayUsd`, and the per-call cap), on the workspace's own top-level files (no dot-files or credential names, never its code folder, each at most 16 KB; a Codex call runs read-only from an empty folder); with no provider or at the cap it is a labelled heuristic draft and no call. The model's text is shown as text, for review. Save (`aos workspace set … --expect`) writes only allow-listed frontmatter keys (summary, objectives, next, status, pinned, repo) that changed, keeps the body and every other key, and refuses a file that changed since the draft |
| Links you made inside the vault are followed | Checks are on the vault's paths; a workspace linked to a code folder is read and written through the link, as you set it up | The page cannot create links |
| An https link can carry data out | Notifications link to the web; the browser shows every link it opens | Opening is visible; the page has no network access of its own (`connect-src 'self'`) |
| A fix-it runs an installer from the network (Homebrew's `install.sh`, npm packages) | That is how those tools install, and the wizard exists so a user need not type it | The commands are fixed in main and shown before they run, in a terminal the user watches and can stop; the page can only pick one, and only while setup shows |
| A compromised page could start a fix-it, the install or an upgrade | They are the wizard's and attach mode's buttons | Each is fixed, allowed only in its state (no install over an attached vault), and visible as it runs |
| An agent session edits a workspace repository and runs commands there (Claude at the **Edit and run commands** level; Codex always, inside its sandbox) | It is the feature: Sessions (spec 2026-10-07-unidex-sessions) | On by default since 1.2.0, after a live turn on each host; `AOS_APP_WRITE` narrows it like any surface (the `sessions` surface, scope `main`: the page never gets its writes). The page sends only a workspace name, a host, a prompt, a thread id, a file or a commit message, each zod-checked. Main asks the runtime (`lib/sessions.js`) for the program, its arguments and its environment, and runs it only as an installed program (`programRefusal`), in `<vault>/workspaces/<name>`, with the allowed variables (`spawnEnv`). The page names a turn's access level (read, edit or run, zod-checked): Claude runs in plan mode for read and in `acceptEdits` otherwise, with no one to answer prompts and Bash only at run; Codex runs in its read-only sandbox for read and its workspace-write sandbox otherwise, without network. The model must not read as a flag. The host catalog (`session:catalog`) runs only `lib/sessions.js catalog` from the runtime, which asks each host for its models without calling one and stores no account details. Each turn is capped (`sessions.perTurnUsd`, `sessions.perDayUsd`), stopped on request and recorded. git commits only on the Commit button with the message shown, and never pushes. Its reads (status, diffs) run no program the repository's own config names: no fsmonitor, signature check, filter driver, external diff, textconv or lazy fetch (spaces-redesign §6, `services/git.ts`). The commit itself runs the repository's hooks, filters and signing (`core.hooksPath`, `commit.gpgsign`), as a commit in a terminal does: that is accepted, since the user asked for it |

## Review: phase 4 (Electron hardening checklist)

Done for phase 4 against Electron's security checklist (the Dev team's `dev-electron-hardening` audit and its
`dev-electron-ipc` pattern), then by an independent reviewer with no part in building it, who attacked the bridge as a
page with script running in it would. The Evidence column's line numbers were last rechecked against the tree after
1.0.0; packaged checks ran on a release-configured build (`npm run dist:verify`) and the smoke build
(`npm run smoke:packaged`).

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Only secure content | pass | `app/src/main/index.ts:342` loads `app://hud/index.html`; `app-scheme.ts` serves only `out/renderer` |
| 2 | No Node integration | pass | `index.ts:304-305` `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`; `sandbox.spec.ts` finds no `require`, `process`, `Buffer` |
| 3 | Context isolation | pass | `index.ts:306` |
| 4 | Sandbox | pass | `index.ts:307`; `sandbox.spec.ts` reads the page's live preferences |
| 5 | Permission requests | pass | `index.ts:336` grants only `clipboard-sanitized-write` |
| 6 | `webSecurity` | pass | on, set explicitly |
| 7 | Content Security Policy | pass | built `out/renderer/index.html`: `script-src 'self'`, no inline script, no `unsafe-eval`, `object-src 'none'`, `connect-src 'self'` |
| 8 | No insecure content | pass | `allowRunningInsecureContent: false` |
| 9, 10 | No experimental or Blink features | pass | not set |
| 11, 12 | `<webview>` | n.a. | `webviewTag: false` |
| 13 | Navigation | pass | `index.ts:329, 334`: every navigation is prevented (an https link goes to the browser) |
| 14 | New windows | pass | `index.ts:320-333`: only the blank tray popover; anything else is denied |
| 15 | `openExternal` | pass | https only (`policy/shell.ts` `externalAllowed`); the menu's one fixed link |
| 16 | A current Electron | pass | 44.5.1, the current release of the current major (phase 5) |
| 17 | IPC sender and arguments | pass | every handler goes through `ipc/trust.ts:33-48`: main window, main frame, `app://hud`, then a zod schema (`ipc/schemas.ts`) |
| 18 | Custom protocol | pass | `app-scheme.ts:39-44`, `protocol.handle` |
| 19 | Fuses | pass | `dist:verify` reads them from the packaged app: `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, archive integrity on, only from the archive, no `file:` privileges |
| 20 | No Electron APIs exposed | pass | `preload/index.ts:88` exposes named functions only; `sandbox.spec.ts` checks the shape |
| | Secrets in code or history | pass | the repository's privacy gate on every commit and in CI |
| | Injection sinks | pass | no `innerHTML`, `eval` or `new Function` in the page's code; Markdown with raw HTML off, then DOMPurify |
| | Entitlements | pass | `allow-jit`, and `apple-events` with its reason (`electron-builder.yml:52`: a command in the terminal may control another app) |
| | Production dependencies | pass | `npm audit --omit=dev`: 0 vulnerabilities. The page's bundled packages are the app's devDependencies; `npm audit` finds nothing in them (rechecked when `@xterm/addon-search` 0.15.0 joined for ⌘F, in 1.4.0): its findings are build tooling only (electron-builder, `@electron/get`) |
| | Remote debugging of a release | pass | `policy/debug.ts`; `dist:verify` starts the release with `--remote-debugging-port`: it exits 1 before anything listens |

The independent review found no critical or high issue. Its findings, and what became of them:

| Finding | Severity | Outcome |
|---|---|---|
| A recursive remove of a writable folder (`brain`) took the runtime's folders with it | medium | fixed: main never removes a folder (the Files tab sends folders to the Trash), and never moves or trashes `brain/_index`, `brain/scripts` or a folder above them |
| Credential files were refused by name only, inside whole host folders (an IDE lock file there carries a token) | medium | fixed: of the hosts' folders the page reads only `agenticos.json`, skills, agents, commands and prompts; it may list the session folders to find a transcript, never read one |
| Whether a program exists can be asked anywhere by its name (`…/node`) | low | accepted: the node, claude and shell pickers need it, and the answer is one bit about a path ending in a program's name |
| Vault chat's `claude -p` and `ask.js --local` take the page's question, host, model, effort and per-call cap | low | accepted: what the Sessions tab's Vault chat does; each argument has its own rule (the model never reads as a flag), the reasoner's daily cap still applies, and the per-call cap is the user's setting, which the Settings tab can change too |
| A web page the page wrote could open in the browser | low | fixed: `.html` and `.svg` open only from `brain/_index` (the runtime's proposal pages), else Finder shows them |
| Links already in the vault are followed | note | accepted (above) |
| The debugging switches are a list | note | fixed: `--inspect-wait` added; the inspector fuse is off, which `dist:verify` checks |

**Verdict: SECURED with notes** — 0 critical, 0 high, 0 medium open; 2 low and 1 note accepted, as recorded above.
