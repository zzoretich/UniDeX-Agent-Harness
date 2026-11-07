# Agent computer, release 1 (Browser) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship release 1 of the Computer pane: an in-app browser on the Code and Chat pages that any Workbench session's agent drives through nine MCP tools, behind an app-owned ask-first gate, on both hosts.

**Architecture:** Main owns what matters. It keeps one `WebContentsView` browser per place, driven through `webContents.debugger`, behind a pure ask gate (D39, D43) with a broker and a wheel. A Unix-socket bridge admits only the agenticos MCP server of a CLI main itself spawned, checked by a native addon (peer PID, process tree, code signature). The runtime's MCP server forwards the nine tools to that socket. The HUD gets a docked pane that reserves a rectangle for the native view and shows asks, the driver and tabs.

**Tech Stack:** Electron 44 (`WebContentsView`, DevTools Protocol), TypeScript (app, HUD), a Node-API Objective-C++ addon built with node-gyp, the Node ≥ 20 CommonJS runtime with `@modelcontextprotocol/sdk` and zod, `node:test`, Playwright Electron.

**Spec:** `docs/design/specs/2026-11-06-agent-computer-design.md` (approved 2026-11-07). Release 1 covers D3–D9, D17–D21, D23, D25–D27, D29–D35, D39, D43, §4.1–§4.4 and §6 "Release 1". Releases 2 (Sandbox) and 3 (Your Mac) get their own plans; the mode switch and the Sandbox tab are not built here.

## Delivery

Four stacked PRs, each green on its own and merged in order with the owner's OK. No release until all four land.

| PR | Branch | Tasks | Lands |
|---|---|---|---|
| A — proof and gate core | `feat/agent-computer` | 1–4 | the D33 and D27 proofs, the pure gate, broker, wheel, site marks, config |
| B — bridge and tools | `feat/agent-computer-bridge` | 5–10 | the addon, admission, the spawn registry, the bridge, nine tools, launch flags |
| C — browser | `feat/agent-computer-browser` | 11–13 | the browser view, the computer service, wiring, ask notices |
| D — pane | `feat/agent-computer-pane` | 14–17 | page calls, the pane, e2e, docs, tour, live checks |

At each PR checkpoint run the verify, publish-check and PR steps of the feature workflow (gate, tests, lint, typecheck, changelog check, parity check; app checks when `app/` or `hud/` changed), then ask the owner before merging. A dependent PR is retargeted to `main` before its base merges.

## Global Constraints

- Electron `^44.5.1`, arm64 only; `app/` needs Node 22.12+; the runtime, `cli` and `tools` stay Node ≥ 20 CommonJS with no new runtime dependency.
- The HUD window keeps `sandbox: true`, `contextIsolation`, `webviewTag: false`. No remote-debugging port, ever (`policy/debug.ts`). The debugger attaches to computer views only, never the HUD (D20).
- Computer views: partition `persist:computer`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload, `backgroundThrottling: false`.
- Navigation allows `http:`, `https:` and `about:blank` only (§4.2), for agent opens, redirects, page navigations and new windows.
- `computer.enabled` true and `computer.askTimeoutSec` 120 (D25); a held call returns within 45 s (D34); the wheel frees after 30 s idle (D31).
- The socket is `<userData>/computer/bridge.sock`, mode 0600 in a 0700 folder; its path goes into `brain/_index/hud-host.json` as `computerSocket` (D18).
- Vendor team IDs: Claude Code `Q6L2SF6YDW`, Codex `2DC432GLL2` (read from the signed claude 2.1.318 and codex-cli 0.167.0 binaries). npm packages: `@anthropic-ai/claude-code`, `@openai/codex`.
- Tools: `computer_status`, `computer_open`, `computer_snapshot`, `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_wait`. Look tools: status, snapshot, screenshot, wait. Plugin sources say `mcp__plugin_agenticos_agenticos__computer_*`; the Codex build rewrites them to `mcp__agenticos__computer_*`.
- Every page-facing call has its channel and `AosBridge` type in `app/src/shared/ipc.ts`, a named preload function, a handler through `app/src/main/ipc/trust.ts`, a zod schema in `schemas.ts`, a rule in `app/src/main/policy/`, and its line in `app/tests/e2e/sandbox.spec.ts`.
- Code comments cite `agent-computer D<n>`. No personal terms: "the Chief of Staff", no home paths, names or emails (`npm run gate -- --require-private`).
- `plugin/` is the source: run `npm run build:codex-plugin` and commit `codex-plugin/` with it. `vault-template/AGENTICOS.md` stays ≤ 9,000 characters.
- Run tests through `npm test`, `npm test -w agentic-os` (HUD), `(cd brain/scripts && npm test)`, `(cd app && npm run test:unit)`, or `node --require ./tools/test-env.js --test <file>`. A bare `node --test` writes into the real vault.
- Added and Changed CHANGELOG bullets carry `<!-- tour: … -->` or `<!-- no-tour: … -->`; new tour steps say `"since": "2.5.0"`.
- Commits use a conventional prefix and end with only `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.

## Review Focus

1. **Frames and shadow DOM.** A login form inside a same-origin iframe or an open shadow root still has its password redacted and masked, and a ref inside it clicks the right element. Test: Task 11, `snapshot pierces frames and shadow roots`.
2. **HiDPI and page zoom.** On a 2× display at 125 % page zoom, masks cover the field and a click by ref lands on the element's centre. Test: Task 11, `rects scale by device pixels and zoom`.
3. **The page moves under a pending ask.** The tab closes, navigates or loses the target before Allow: nothing runs, and the reply says the page changed. Test: Task 12, `allowed action is dropped when the page changed`.
4. **The turn ends mid-ask.** A Chat turn finishes or the CLI exits while its ask is pending: the ask is cancelled and nothing runs after the turn. Test: Task 12, `turn end cancels the pending ask`.
5. **Huge pages.** A 50,000-node accessibility tree gives a snapshot capped at 40,000 characters with a truncation note, inside 2 s; a very tall page screenshots the viewport only. Test: Task 11, `snapshot caps size with a note`.

---

## File Structure

| Area | Files | Responsibility |
|---|---|---|
| Gate core | `app/src/main/computer/{categories,gate,asks,wheel,sites,config}.ts`, `app/src/main/policy/computer-url.ts` | D43 vocabulary, D39/D17/D9 verdicts, held asks (D7, D34), the wheel (D31), per-origin marks, `computer.*` |
| Peer addon | `app/native/peer/{binding.gyp,peer.mm}`, `app/scripts/build-native.mjs`, `app/src/main/computer/peer.ts` | peer PID, process info, signing team ID |
| Admission | `app/src/main/computer/{registry,admission}.ts`, `app/src/main/policy/agent-launch.ts` | spawned agents, D18 admission, the Code-launch argv check |
| Bridge | `app/src/main/computer/bridge.ts`, `app/src/main/hud-host.ts`, `brain/scripts/lib/hud-host.js`, `app/src/shared/surfaces.ts` | the socket, JSON lines, the marker field, the `computer` surface |
| Tools | `brain/scripts/sdk/computer-tools.js`, `brain/scripts/sdk/lib/computer-client.js`, `brain/scripts/sdk/mcp-server.js` | nine MCP tools and their socket client |
| Launch flags | `brain/scripts/lib/headless.js`, `hud/src/data/terminalLaunch.ts`, `cli/codex-host.js` | D33 pre-approval per host and mode |
| Spawning | `app/src/main/services/{sessions,pty}.ts`, `hud/src/data/{terminalSession,terminalPool,terminalLauncher}.ts`, `brain/scripts/lib/sessions.js` | Chat turns and Code launches registered; the CLI as the terminal's own process |
| Browser | `app/src/main/computer/{browser,cdp,snapshot,mask}.ts` | the view, schemes, permissions, downloads, input, snapshots, masked screenshots |
| Service | `app/src/main/computer/{service,notify}.ts`, `app/src/main/index.ts` | routing, gate and wheel per call, revalidation, take over, notices, wiring |
| Page calls | `app/src/shared/ipc.ts`, `app/src/preload/index.ts`, `app/src/main/ipc/computer.ts`, `app/src/main/policy/computer.ts`, `app/src/renderer/bridgeHost.ts`, `hud/src/host.ts` | the `computer` namespace |
| Pane | `hud/src/ui/{ComputerPane,ComputerAsk,columnResize}.ts`, `hud/src/ui/{TerminalPanel,TermList}.ts`, `hud/src/views/{SessionsTab,WorkbenchView}.ts`, `hud/src/settingsDefaults.ts`, `hud/styles.css` | the docked pane, asks, badges, row dots |
| Docs | `SECURITY.md`, `README.md`, `app/README.md`, `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md`, `CHANGELOG.md`, `hud/src/tour/{steps,whatsnew}.json` | what changed, what it guarantees, how to check it |

---

### Task 1: Prove D33 and D27 before building on them

**Files:** nothing in the repo. Scratch scripts live outside the checkout; results go under "Proof results" at the end of this task and into the PR A body.

The owner's OK comes first: E1–E5 run real host turns (a few cents). A 2026-09 spike found that Codex's server-level approval key did not stop it cancelling non-read-only MCP calls (codex-compat design D12). The per-tool key in codex-cli 0.167 is untested.

- [ ] **Step 1:** Set up the worktree: `npm ci --ignore-scripts`, then `(cd app && npm ci && node node_modules/electron/install.js)`.
- [ ] **Step 2:** Write a throwaway stdio MCP server `probe`. It has `probe_act` (`readOnlyHint: false`, appends a line to a file) and `probe_look` (`readOnlyHint: true`).
- [ ] **Step 3 (E1):** Run `codex exec --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c approval_policy="never"` with `probe` set through `-c mcp_servers.probe.command/args`, plus `-c mcp_servers.probe.tools.probe_act.approval_mode="approve"`, and the prompt "Call probe_act once." Pass: the file gets its line. Fail: `user cancelled MCP tool call`.
- [ ] **Step 4 (E2):** Repeat E1 with `mcp_servers.probe.default_tools_approval_mode="approve"` instead.
- [ ] **Step 5 (E3):** Serve `probe` from a Codex plugin `.mcp.json`, the way plugin mode does. Repeat E1's override, then try the approval keys inside the plugin's server entry.
- [ ] **Step 6 (E4):** Start an interactive `codex -s workspace-write -a on-request` with the passing override. Pass: `probe_act` runs with no approval prompt.
- [ ] **Step 7 (E5):** Run `claude -p --permission-mode acceptEdits --permission-prompts none --allowedTools mcp__probe__probe_act --mcp-config <file>` with the prompt "Call probe_act once." Pass: the file gets its line.
- [ ] **Step 8 (D27):** In a scratch Electron 44.5.1 script, load a local page in a `WebContentsView` and try `Page.captureScreenshot` and `Input.dispatchMouseEvent` in three states: (a) attached at its bounds, (b) attached with its bounds moved outside the window's content, (c) removed from the window. Record which states paint and take input.
- [ ] **Step 9:** Record the results below. **Stop if E1–E4 all fail:** Codex's scope goes back to the owner before Task 10 (D33). Task 10 uses the first Codex mechanism that passed in each mode; Task 11 uses the first off-screen state that worked (expected: b).

Proof results (2026-11-07, codex-cli 0.167.0, Claude Code 2.1.318, Electron 44.5.1):

| Run | Mechanism | Result |
|---|---|---|
| E0 | Codex, `approval_policy="never"`, no key | refused: "MCP tool call requires approval, but approval policy is never" |
| E1 | E0 + `mcp_servers.<name>.tools.<tool>.approval_mode="approve"` | runs |
| E2 | E0 + `mcp_servers.<name>.default_tools_approval_mode="approve"` | runs |
| E3 | plugin mode: a launch-time `-c mcp_servers.<name>…` override | config load fails ("invalid transport") |
| E3 | plugin mode: the per-tool key inside the plugin's `.mcp.json` server entry | runs |
| E4 | `approval_policy="on-request"` + the per-tool key | runs without a prompt |
| E5 | Claude Code `-p --permission-prompts none --allowedTools <tool>` | runs (denied without it) |
| D27 | `WebContentsView` off-screen | input lands in every state; screenshots hang when far off-screen, `setVisible(false)` or in a hidden window; they work at real bounds, 0x0, detached, minimized or at opacity 0 |

So D33 keeps full parity: Task 10 ships the per-tool keys in each Codex registration (the plugin's server entry and the direct-mode registration) and passes no launch-time `-c mcp_servers…` override; Claude gets `--allowedTools` at launch. Task 11 parks hidden views in an opacity-0, click-through window (ruling R4).

### Task 2: The ask-first vocabulary (D43)

**Files:** Create `app/src/main/computer/categories.ts`. Test `app/tests/unit/computer-categories.test.ts`.

**Interfaces:** Produces:
```ts
export type AskCategory = "submit" | "purchase" | "send" | "delete" | "merge" | "signin" | "download";
export interface Target { role: string; name: string; inForm: boolean; fileInput: boolean }
export const VOCABULARY: Readonly<Record<AskCategory, readonly string[]>>;
export function categoryOf(t: Target): AskCategory | null;
```

- [ ] **Step 1: Write the failing tests**
```ts
const b = (name: string, inForm = false) => categoryOf({ role: "button", name, inForm, fileInput: false });
test("D43 labels ask, case-insensitive, whole words", () => {
  assert.equal(b("Merge pull request"), "merge");   assert.equal(b("SIGN IN"), "signin");
  assert.equal(b("Place order"), "purchase");       assert.equal(b("Delete branch"), "delete");
  assert.equal(b("Download PDF"), "download");      assert.equal(b("Approve"), "merge");
  assert.equal(b("Allow"), "signin");               assert.equal(b("Archive"), null);
  assert.equal(b("Sender settings"), null);         assert.equal(b("Continue"), null);
  assert.equal(b("Continue", true), "submit");      assert.equal(b("Save", true), "submit");
});
test("only button-like roles match", () => {
  assert.equal(categoryOf({ role: "heading", name: "Delete", inForm: false, fileInput: false }), null);
  assert.equal(categoryOf({ role: "link", name: "Sign in", inForm: false, fileInput: false }), "signin");
});
```
- [ ] **Step 2:** Run `(cd app && npm run test:unit)`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `categoryOf`.** The vocabulary is D43's, verbatim. submit: Submit, Confirm, plus Continue and Save on a form. purchase: Buy, Pay, Place order, Checkout, Check out, Subscribe. send: Send, Post, Publish, Reply, Share, Tweet. delete: Delete, Remove, Erase, Discard, Empty Trash. merge: Merge, Squash and merge, Rebase and merge, Approve. signin: Sign in, Log in, Authorize, Connect, Grant, Allow. download: Download, Export, Save to disk. Approve and Allow ask in any context: their review and consent contexts can't be read reliably, so this fails closed (planner's call). Roles: button, link, menuitem, menuitemcheckbox, menuitemradio. Match a whole-word phrase in the lower-cased name, punctuation stripped.
- [ ] **Step 4:** Run the unit tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the D43 ask-first vocabulary`.

### Task 3: Scheme policy and gate verdicts (§4.2, D39, D17, D9)

**Files:** Create `app/src/main/policy/computer-url.ts` and `app/src/main/computer/gate.ts`. Test `app/tests/unit/computer-url.test.ts` and `app/tests/unit/computer-gate.test.ts`.

**Interfaces:** Consumes `Target` and `categoryOf` (Task 2). Produces:
```ts
export function navAllowed(url: string): boolean;     // http:, https:, about:blank
export function siteOf(url: string): string | null;   // the origin; null for about:blank or junk
export type Access = "read" | "edit" | "run" | "host";
export interface Focus { target: Target | null; sensitive: boolean; plainTextarea: boolean }  // native <textarea>, no key listener on it or an ancestor
export type Action =
  | { kind: "status" | "snapshot" | "screenshot" | "wait" | "scroll" }
  | { kind: "open"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "key"; key: string; focus: Focus }
  | { kind: "type"; text: string; focus: Focus };
export type AskWhy = AskCategory | "unmarked" | "return" | "file" | "permission";
export type Verdict = { go: true } | { ask: AskWhy } | { refuse: string };
export const NAV_KEYS: ReadonlySet<string>;   // ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Tab Shift+Tab Escape
export function judge(a: Action, ctx: { access: Access; marked: boolean }): Verdict;
```
The rules apply in this order:
1. Read access lets only status, snapshot, screenshot and wait through. Anything else is refused with "Read only: this session can look but not act (D17)."
2. `open` goes when `navAllowed`, else is refused with "Only http and https pages open."
3. status, snapshot, screenshot, wait and scroll go.
4. `click`: a file input asks `file`; an unmarked site asks `unmarked`; a D43 match asks its category; anything else goes.
5. `key`: any chord containing Enter asks `return`, unless the focus is a plain textarea (then it is judged like any other key). `NAV_KEYS` go. Any other key on an unmarked site asks `unmarked`. On a marked site, Space is judged as a click on the focused target (no target: go), and other keys go.
6. `type`: a sensitive focus is refused with "Typing into a password field is refused (D9)." A newline asks `return`, unless the focus is a plain textarea. An unmarked site asks `unmarked`; a file input asks `file`; anything else goes.

- [ ] **Step 1: Write the failing tests**, table-driven, one row per rule:
```ts
const field: Focus = { target: { role: "textbox", name: "Email", inForm: true, fileInput: false }, sensitive: false, plainTextarea: false };
assert.deepEqual(judge({ kind: "click", target: btn("Next") }, { access: "edit", marked: false }), { ask: "unmarked" });
assert.deepEqual(judge({ kind: "key", key: "Tab", focus: field }, { access: "edit", marked: false }), { go: true });
assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: btn("Next") } }, { access: "edit", marked: false }), { ask: "unmarked" });
assert.deepEqual(judge({ kind: "click", target: btn("Merge pull request") }, { access: "edit", marked: true }), { ask: "merge" });
assert.deepEqual(judge({ kind: "key", key: "Enter", focus: field }, { access: "edit", marked: true }), { ask: "return" });
assert.deepEqual(judge({ kind: "type", text: "hi\n", focus: { ...field, plainTextarea: true } }, { access: "edit", marked: true }), { go: true });
assert.deepEqual(judge({ kind: "type", text: "x", focus: { ...field, sensitive: true } }, { access: "edit", marked: true }), { refuse: "Typing into a password field is refused (D9)." });
assert.ok("refuse" in judge({ kind: "open", url: "https://a.test" }, { access: "read", marked: true }));
assert.deepEqual(judge({ kind: "snapshot" }, { access: "read", marked: false }), { go: true });
for (const u of ["javascript:alert(1)", "data:text/html,x", "blob:https://a.test/1", "file:///etc/hosts", "agenticos://x", "chrome://gpu", "devtools://x", "about:srcdoc"]) assert.equal(navAllowed(u), false);
assert.equal(navAllowed("about:blank"), true);
```
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3:** Implement `navAllowed`, `siteOf` and `judge` as listed above.
- [ ] **Step 4:** Run the unit tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the scheme policy and gate verdicts`.

### Task 4: Asks, the wheel, site marks and config (D7, D31, D34, D25)

**Files:** Create `app/src/main/computer/{asks,wheel,sites,config}.ts`. Modify `brain/scripts/config.default.json`, `brain/scripts/lib/settings-schema.js` (rows, choices, the `computer` section), and `hud/src/data/aosConfig.ts` (`VaultConfig`, `VAULT_CONFIG_DEFAULTS`). Test `app/tests/unit/computer-{asks,wheel,sites,config}.test.ts`; `brain/scripts/test/settings-schema.test.js` and `hud/src/data/aosConfig.test.ts` stay green.

**Interfaces:** Consumes `AskWhy` (Task 3). Produces:
```ts
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void }
export interface AskInput { computer: string; session: string; sessionLabel: string; why: AskWhy; title: string; detail: string; site: string | null }
export interface Ask extends AskInput { id: string; at: number }
export type Answer = "once" | "always" | "deny";
export type Outcome = { state: "allowed" | "denied"; askId: string; answer?: Answer; reason?: string } | { state: "waiting_for_user"; askId: string };
export class AskBroker {
  constructor(o: { timeoutMs: () => number; holdMs?: number /* 45_000 */; clock?: Clock; onChange: (pending: readonly Ask[]) => void });
  hold(input: AskInput): Promise<Outcome>;  wait(askId: string): Promise<Outcome>;
  answer(askId: string, a: Answer): boolean;  cancel(match: (a: Ask) => boolean, reason: string): number;
  pending(computer?: string): readonly Ask[];
}
export type Holder = { kind: "agent"; session: string; label: string } | { kind: "user"; resume: { session: string; label: string } | null } | null;
export class Wheel {
  constructor(o: { idleMs?: number /* 30_000 */; clock?: Clock; reserved: (computer: string) => boolean; onChange: (computer: string, h: Holder) => void });
  take(computer: string, session: string, label: string): { ok: true } | { ok: false; busy: string };
  touch(computer: string, session: string): void;  turnEnded(session: string): void;
  takeOver(computer: string): void;  handBack(computer: string): void;  holder(computer: string): Holder;
}
export class SiteMarks {   // <userData>/computer/sites.json, written 0600 by temp file and rename
  constructor(file: string);
  isMarked(url: string): boolean;                       // localhost, 127.0.0.1, [::1] start marked
  mark(origin: string): void;  unmark(origin: string): void;  list(): string[];
  allowCategory(origin: string, c: AskCategory): void;  categoryAllowed(origin: string, c: AskCategory): boolean;
}
export interface ComputerConfig { enabled: boolean; askTimeoutSec: number }
export function computerConfig(vault: string | null): ComputerConfig;  // brain/config.json, then agenticos.json, as in updater.ts:31-40
```
- [ ] **Step 1: Write the failing tests** (fake clock):
  - **broker:** an answer settles `allowed`; with no answer, `waiting_for_user` arrives at 45,000 ms with the id. `wait(id)` followed by an answer gives `allowed`. No answer by 120,000 ms gives `denied` and clears the ask. `cancel` settles `denied` with its reason. `onChange` fires on add, answer and cancel. An unknown id waits as `denied`.
  - **wheel:** the first `take` holds the wheel, and a second session gets `busy` with the holder's label. 30,000 ms idle frees the wheel, but a reserved computer never frees by idle. `turnEnded` frees it. `takeOver` makes the user the holder ("the user is driving"), and `handBack` returns the wheel to the previous agent.
  - **sites:** localhost is marked from the start. A mark survives a new instance, and the file is written with mode 0600. A broken file reads as empty and never throws. A category allowance is per origin.
  - **config:** with no vault, the defaults apply. `brain/config.json` setting `computer.askTimeoutSec` to 300 wins over the default, and `agenticos.json` wins over that.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3: Implement the four modules and the config keys.**
  - `config.default.json` gets `"computer": { "enabled": true, "askTimeoutSec": 120 }`.
  - The schema gets two rows: `{ key: 'computer.enabled', section: 'computer', label: 'Computer pane', type: 'bool', applies: 'next-call', help: 'The in-app browser agents can drive on the Code and Chat pages.' }` and `{ key: 'computer.askTimeoutSec', section: 'computer', label: 'Ask timeout', type: 'number', int: true, min: 30, applies: 'next-call', help: 'Seconds an ask waits before it counts as Deny.' }`, with choices `[60, 120, 300, 600]` and unit `s`.
  - Mirror the section into `VAULT_CONFIG_DEFAULTS`.
- [ ] **Step 4:** Run `(cd app && npm run test:unit)`, `(cd brain/scripts && npm test)` and `npm test -w agentic-os`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the ask broker, wheel, site marks and config`. **PR A checkpoint.**

### Task 5: The peer addon (D18)

**Files:** Create `app/native/peer/binding.gyp`, `app/native/peer/peer.mm`, `app/scripts/build-native.mjs` and `app/src/main/computer/peer.ts`. Modify:
- `app/package.json`: `postinstall` runs build-native after `fix-pty.mjs`; add `node-gyp` as a pinned devDependency.
- `app/scripts/build.mjs`: mark the addon external.
- `app/electron-builder.yml`: add `native/peer/build/Release/peer.node` to `files` and `asarUnpack`.
- `app/scripts/verify-dist.mjs`: the addon is present and signed.

Test `app/tests/unit/computer-peer.test.ts`.

**Interfaces:** Produces:
```ts
export interface ProcInfo { pid: number; ppid: number; path: string; argv: string[] }
export interface PeerAddon { peerPid(fd: number): number; procInfo(pid: number): ProcInfo | null; teamId(path: string): string | null }
export function loadPeer(): PeerAddon;              // the unpacked path when packaged
export function socketFd(s: net.Socket): number;    // the accepted socket's fd; throws when unavailable
```
- [ ] **Step 1: Write the failing tests:**
  - `peerPid(socketFd(conn)) === process.pid` for a connection from this process to a temp socket.
  - `procInfo(process.pid)` has `ppid === process.ppid`, `path === fs.realpathSync(process.execPath)` and at least 2 argv entries; `procInfo(999999)` is null.
  - `teamId("/bin/ls")` is null (a platform binary has no team), and an unsigned temp script gives null.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL, addon missing.
- [ ] **Step 3: Implement the addon in plain Node-API (`node_api.h`, no node-addon-api).** Link Security and CoreFoundation.
  - `peerPid`: `getsockopt(SOL_LOCAL, LOCAL_PEERPID)`.
  - `procInfo`: `proc_pidinfo(PROC_PIDTBSDINFO)` for the parent, `proc_pidpath` for the path, and `sysctl({CTL_KERN, KERN_PROCARGS2, pid})` for argv.
  - `teamId`: `SecStaticCodeCreateWithPath`, then `SecStaticCodeCheckValidity` must pass, then `SecCodeCopySigningInformation(kSecCSSigningInformation)` gives `kSecCodeInfoTeamIdentifier`. Unsigned, ad hoc and invalid code give null.
  - `socketFd`: reads the socket handle's `fd`.
- [ ] **Step 4:** Run `(cd app && npm ci && npm run test:unit)`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the peer addon for bridge admission`.

### Task 6: Admission and the spawned-agent registry (D18, D17)

**Files:** Create `app/src/main/computer/registry.ts` and `app/src/main/computer/admission.ts`. Test `app/tests/unit/computer-admission.test.ts`.

**Interfaces:** Consumes `ProcInfo` (Task 5) and `Access` (Task 3). Produces:
```ts
export interface AgentRef { pid: number; host: "claude" | "codex"; page: "chat" | "code"; key: string /* chat:<thread> | code:<terminal id> */; label: string; place: string; access: Access }
export class AgentRegistry { add(a: AgentRef): void; remove(pid: number): void; get(pid: number): AgentRef | undefined; claim(pid: number): boolean }  // claim succeeds once per pid
export interface Sys { procInfo(pid: number): ProcInfo | null; teamId(path: string): string | null; realpath(p: string): string }
export const VENDOR: Readonly<Record<"claude" | "codex", { team: string; pkg: string }>>;
export type Admit = { ok: true; agent: AgentRef } | { ok: false; reason: string };
export function launchForm(host: "claude" | "codex", bin: string, sys: Sys, trusted?: readonly string[]): "native" | "npm" | null;
export function installForm(host: "claude" | "codex", p: ProcInfo, sys: Sys, trusted?: readonly string[]): "native" | "npm" | null;
export function admit(peerPid: number, o: { reg: AgentRegistry; sys: Sys; server: string; trusted?: readonly string[] }): Admit;
```
Admission runs in this order:
1. The peer's `realpath(argv[1])` must equal `server` (the vault's `brain/scripts/sdk/mcp-server.js`; the launcher `exec`s node, so no process sits between).
2. The peer's parent is registered, and `installForm` accepts it.
3. Or the parent is a Codex-signed binary whose own parent is a registered npm-form Codex (the npm shim case).
4. Anything else is refused: "Not started by UniDeX: start this session from the Code page's New menu or a Chat thread."
5. `claim` fails for a second connection: "This session's computer connection is already open."

Install forms:
- **native:** `teamId(realpath(path))` equals the host's team.
- **npm:** the basename of `path` is `node`, and `realpath(argv[1])` lies inside `/node_modules/<pkg>/`.
- `launchForm` applies the same tests to a binary path before launch: a signature, or a script whose realpath is inside the package.
- `trusted` lists realpaths treated as native, in test builds only (Task 13).

- [ ] **Step 1: Write the failing tests** with a table and a fake `Sys`:
  - **admitted:** a native Claude child; a Homebrew Codex; an npm Claude; the npm Codex shim, then native codex, then the server.
  - **refused:** a node script under a shell under the CLI (an npm script, the agent's Bash); a parent outside the app; an unregistered process with forged `claude` argv; a second server under one CLI; a wrong server path; a CLI signed by another team.
  - **launchForm:** accepts both install forms and refuses an unsigned binary.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3:** Implement the registry and admission as listed.
- [ ] **Step 4:** Run the unit tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): admit only app-spawned agent MCP servers`.

### Task 7: Register what the app spawns (D18, D30)

**Files:**
- Modify `app/src/main/services/sessions.ts` (an `onAgent` option) and `app/src/main/services/pty.ts` (`spawnAgent`).
- Create `app/src/main/policy/agent-launch.ts`.
- Modify `app/src/shared/ipc.ts`, `app/src/preload/index.ts`, `app/src/main/ipc/proc.ts`, `app/src/main/ipc/schemas.ts`, `app/src/renderer/bridgeHost.ts`, `hud/src/host.ts`, `hud/src/data/{terminalSession,terminalPool,terminalLauncher,terminalLaunch}.ts`, and `brain/scripts/lib/sessions.js` (verb `bin`).
- Test `app/tests/unit/{agent-launch,sessions}.test.ts`, `hud/src/data/terminalSession.test.ts`, `brain/scripts/test/sessions-bin.test.js`, and the `pty` line in `app/tests/e2e/sandbox.spec.ts`.

**Interfaces:** Consumes `AgentRegistry` and `launchForm` (Task 6). Produces:
```ts
// sessions.ts option
onAgent?: (ev: { kind: "start"; pid: number; thread: string; workspace: string; host: "claude" | "codex"; access: "read" | "edit" | "run"; title: string } | { kind: "end"; pid: number; thread: string }) => void;
// policy/agent-launch.ts
export function agentArgvRefusal(host: "claude" | "codex", argv: readonly string[]): string | null;  // only flags launchArgs emits
// pty.ts
export interface PtyAgentRequest { id: string; host: "claude" | "codex"; argv: string[]; cwd: string; configDir: string | null; gitInit: boolean; cols: number; rows: number; place: string; label: string; access: "host" | "read" | "edit" | "run" }
spawnAgent(req: PtyAgentRequest): Promise<Result<{ pid: number }>>;
// IPC: CH.ptySpawnAgent = "pty:spawn-agent" (invoke); AosBridge.pty.spawnAgent(req)
// HUD
export function placeKey(p: Place): string;   // workspace and scratch: the workspace name; "vault"; "home"; "dir:<abs path>"
HostPty.spawnAgent?(req): Promise<HostResult<HostPtyProcess>>;
TerminalPool.createAgent(o: { spec: LaunchSpec; place: Place; meta: TerminalMeta }): Promise<TerminalSession>;
// runtime: node brain/scripts/lib/sessions.js bin <host> → {"ok":true,"bin":"<path>"} via headless.resolveBin
```
Behaviour:
- **spawnAgent** runs these steps in order:
  1. Resolve the binary with the runtime's `bin` verb, the same resolution Chat turns use.
  2. `launchForm` must accept it. Otherwise refuse with "<Host> at <path> isn't a supported install: <reason>", which the Code page shows before any terminal opens.
  3. Apply `cwdRefusal` and `agentArgvRefusal`.
  4. Build the env: `ptyEnv`, plus `CLAUDE_CONFIG_DIR` or `CODEX_HOME` from `configDir`.
  5. Run `git init -q` first when `gitInit` is set and there is no `.git`.
  6. Call `node-pty spawn(bin, argv)`.
  7. `registry.add` with `page: "code"` and `key: code:<id>`; `registry.remove` on exit.
- **The terminal:** when an agent's process exits, `TerminalSession` replaces its pty with the user's login shell in the same terminal and folder. The end bar's Resume is kept, and the terminal counts as exited only when that shell exits. `launchLine` stays for `previewLine` only.
- **Chat:** `onAgent({kind:"start"})` fires right after `state.agent = agent` (sessions.ts:385), and `{kind:"end"}` fires on the child's exit. index.ts maps these onto the registry, with `place` set to the thread's workspace (Task 13).

- [ ] **Step 1: Write the failing tests:**
  - `agentArgvRefusal` accepts every argv `launchArgs` builds: Claude with each access level and resume form, and Codex fresh and resume.
  - It refuses `--dangerously-skip-permissions`, `--mcp-config`, an unknown flag, a value starting with `-`, and any `-c` key except Task 10's approval keys.
  - `sessions.test.ts`: `onAgent` start and end with a fake `spawnImpl`.
  - The HUD session swaps to a shell when the agent exits.
  - The runtime `bin` verb prints the resolved path.
- [ ] **Step 2:** Run the app unit tests, the HUD tests and the runtime tests. Expected: FAIL.
- [ ] **Step 3:** Implement as listed, and route `terminalLauncher.start` for agent hosts through `pool.createAgent`.
- [ ] **Step 4:** Run the same tests, and add `"spawnAgent"` to the `pty` line in `sandbox.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): run Code launches as the terminal's own process and register spawned agents`.

### Task 8: The bridge and the marker (D18, D26)

**Files:** Create `app/src/main/computer/bridge.ts`. Modify `app/src/main/hud-host.ts`, `app/src/main/index.ts` (start and stop; a stub `handle` until Task 12), `brain/scripts/lib/hud-host.js` and `app/src/shared/surfaces.ts`. Test `app/tests/unit/computer-bridge.test.ts`, `app/tests/unit/hud-host.test.ts` and `brain/scripts/test/hud-host.test.js`.

**Interfaces:** Consumes `admit`, `AgentRef` (Task 6) and `PeerAddon` (Task 5). Produces:
```ts
export type ComputerTool = "computer_status" | "computer_open" | "computer_snapshot" | "computer_screenshot" | "computer_click" | "computer_type" | "computer_key" | "computer_scroll" | "computer_wait";
export interface ToolCall { id: number; tool: ComputerTool; args: Record<string, unknown> }
export interface ToolReply { id: number; text: string; image?: { data: string; mimeType: "image/png" }; isError?: boolean }
export class ComputerBridge {
  constructor(o: { socketPath: string; admit: (peerPid: number) => Admit; peer: PeerAddon; handle: (agent: AgentRef, call: ToolCall) => Promise<Omit<ToolReply, "id">>; onClose: (agent: AgentRef) => void });
  start(): Promise<void>;  stop(): Promise<void>;
}
```
- **Protocol (JSON lines):**
  - The client sends `{"hello":1}`. The server answers `{"admitted":true,"session":"<label>"}`, or `{"admitted":false,"reason":"…"}` and then closes.
  - After admission, `ToolCall` lines flow; replies match by id, and calls may overlap.
  - An incoming line over 1 MiB closes the connection. A closed connection never reopens for that CLI (first connection wins).
- **Socket:** create `<userData>/computer` with mode 0700, unlink a stale socket, listen, then `chmod 0600`. Refuse to start when the path exceeds 103 bytes.
- **Marker:** `HudHostMarker` gains `computerSocket?: string`, written once the bridge listens; the runtime's `readMarker` returns it when it is a string.
- **Surface:** `{ id: "computer", label: "Computer", source: "main/computer (bridge socket, ask notices)", writes: [], scope: "main", spawns: [], verified: false }` (Task 13 adds the notify spawn).
- **Stub:** until Task 12, `computer_status` answers the session's label, place and access, and every other tool answers "The browser arrives with the next part of release 1."

- [ ] **Step 1: Write the failing tests** with a real temp socket and a fake `admit`:
  - an admitted hello, then a call routed with its `AgentRef`;
  - a refused hello gets the reason and the socket closes;
  - a 2 MiB line closes the connection;
  - overlapping calls are answered by id;
  - the modes are 0600 and 0700, a stale socket is replaced, and a long path is refused.
  - Both marker tests cover the shape with and without `computerSocket`.
- [ ] **Step 2:** Run the app unit tests and the runtime tests. Expected: FAIL.
- [ ] **Step 3:** Implement the bridge, the marker field and the surface entry; start the bridge in index.ts after the vault attaches.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): serve the bridge socket and publish it in the marker`.

### Task 9: Nine MCP tools (§4.3, D19, D21, D34)

**Files:**
- Create `brain/scripts/sdk/lib/computer-client.js` and `brain/scripts/sdk/computer-tools.js`.
- Modify `brain/scripts/sdk/mcp-server.js`: register the tools at start, and update the tool list and the "only write tool" wording at :8-24, :42 and :376.
- Modify the name lists in `brain/scripts/test/wrap-session-tool.test.js` (:32-36, :93-94), `vault-template/AGENTICOS.md:16`, `plugin/skills/wrap/SKILL.md:10`, and the rebuilt `codex-plugin/`.
- Test `brain/scripts/test/computer-tools.test.js`.

**Interfaces:** Consumes the bridge protocol (Task 8). Produces:
```js
/** One connection per process, opened at start; call() never rejects. */
function createComputerClient({ vault, net = require('net'), readMarker = require('../../lib/hud-host.js').readMarker, timeoutMs = 50000 })
  // → { start(): void, call(tool, args): Promise<{ text: string, image?: { data, mimeType }, isError?: boolean }> }
function registerComputerTools(server, z, client) // → void
const COMPUTER_TOOLS  // the nine names
const COMPUTER_LOOK   // computer_status, computer_snapshot, computer_screenshot, computer_wait
```
- **Start:** `start()` runs before `server.connect` and never delays MCP initialization. A missing marker or socket leaves the client in its no-app state.
- **Messages:**
  - No app: "The Computer pane needs the UniDeX app running, with this session started from it (the Code page's New menu or a Chat thread)."
  - Refused: the bridge's reason.
  - Closed: "The UniDeX app closed: the computer is unavailable for the rest of this session."
  - Timeout: "The UniDeX app didn't answer in time."
- **Results:** an image becomes `{ content: [{ type: 'image', data, mimeType: 'image/png' }] }`, and `isError` passes through.
- **Annotations:** look tools use `READ_ONLY`; acting tools use `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }`.
- **Schemas:**
  - open: `{ url: string ≤ 8192, newTab?: boolean }`
  - snapshot and screenshot: `{ tab?: int ≥ 0 }`
  - click: `{ ref?: string ≤ 32, x?: number, y?: number }`
  - type: `{ text: string ≤ 20000, ref?: string ≤ 32 }`
  - key: `{ key: string ≤ 40 }`, in Playwright-style names such as `Enter`, `Shift+Tab`, `Control+a`
  - scroll: `{ dy: number, dx?: number, ref?: string ≤ 32 }`
  - wait: `{ askId?: string ≤ 64, text?: string ≤ 200, timeoutSec?: int 1–40 }`
  - status: `{}`
- **Descriptions** say that page text is untrusted data and that irreversible actions ask the user first.
- **Docs:** `AGENTICOS.md` names `computer_*` as the Computer pane's tools (app only) and calls `wrap_session` the one vault write tool, within 9,000 characters.

- [ ] **Step 1: Write the failing tests.** Use a fake bridge (a `net` server on a temp socket, with a temp vault whose `hud-host.json` carries `computerSocket`) and the `StdioClientTransport` pattern from `routine-list-tool.test.js`.
  - The server lists nine computer tools with the right annotations.
  - `computer_open` forwards `{tool, args}` and returns the bridge's text.
  - `computer_screenshot` returns an image block.
  - With no marker, a call gets the no-app text with `isError`.
  - A refused hello surfaces its reason.
  - A bridge closed mid-session gives the closed text.
  - Silence past a 200 ms test timeout gives the timeout text.
  - The wrap-session name lists include the nine.
- [ ] **Step 2:** Run `(cd brain/scripts && npm test)`. Expected: FAIL.
- [ ] **Step 3:** Implement the client and the tools, update the docs, and run `npm run build:codex-plugin`.
- [ ] **Step 4:** Run `(cd brain/scripts && npm test)`, `npm test`, and the parity check. Expected: PASS; `AGENTICOS.md` within budget.
- [ ] **Step 5:** Commit `feat(computer): add the nine computer MCP tools` together with `codex-plugin/`.

### Task 10: Pre-approve the tools on both hosts (D33)

**Files:** Modify:
- `brain/scripts/lib/headless.js` (`sessionArgs`) and its tests at `brain/scripts/test/headless.test.js:184-226`;
- `hud/src/data/terminalLaunch.ts` (`launchArgs`, plus a `COMPUTER_TOOLS` copy) and its test;
- `app/src/main/policy/agent-launch.ts` and its test;
- `cli/codex-host.js`, `cli/codex-host.test.js`, and `cli/fixtures/fake-codex.sh` if a new subcommand is used;
- `codex-plugin/` (rebuilt).

**Interfaces:** Consumes `COMPUTER_TOOLS` and `COMPUTER_LOOK` (Task 9) and Task 1's results.

Decisions:
- **Claude, Chat and Code:** one `--allowedTools` flag with a comma-joined value. Read access gets the four look tools; edit gets all nine; run gets `Bash` plus all nine; a Code launch's Host default gets all nine. Names use the plugin form `mcp__plugin_agenticos_agenticos__<tool>`.
- **Codex, Chat (except read) and Code (edit, run, host):** one approval override per acting tool, using the mechanism Task 1 proved. The candidate is `-c mcp_servers.agenticos.tools.<tool>.approval_mode="approve"`. Look tools need nothing, because they are annotated read-only.
- **Codex registration:** write the approval wherever Task 1 showed it reaches the server: the plugin's `.mcp.json` entry from `pluginMcpServers()` in plugin mode, and the direct-mode registration. A mode with no working mechanism stays on the launch overrides, and the PR body says so.
- **The HUD's `COMPUTER_TOOLS`** must equal the runtime export; a HUD test reads `brain/scripts/sdk/computer-tools.js`.

- [ ] **Step 1: Write the failing tests:**
  - Claude `sessionArgs` per level gives the exact `--allowedTools` value; update the full-argv `deepEqual`s at :186-190.
  - Codex edit gives five approval overrides, and read gives none.
  - `launchArgs` matches per host and access, and the two lists are equal.
  - `agentArgvRefusal` accepts these flags and still refuses other `-c` keys.
  - The Codex registration writes the approval in plugin mode (assert on `pluginMcpServers()`) and in direct mode (assert on the fake-codex log).
- [ ] **Step 2:** Run the runtime, HUD, app unit and `cli` tests. Expected: FAIL.
- [ ] **Step 3:** Implement the flags and the registration, and run `npm run build:codex-plugin`.
- [ ] **Step 4:** Run the same tests and both rehearsals (`sh cli/rehearsal/first-run.sh`, `sh cli/rehearsal/codex-host.sh`). Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): pre-approve the computer tools in Workbench sessions on both hosts`.
- [ ] **Step 6:** Run the live reach check, with the owner's OK. On Claude Code and Codex, a Chat turn and a Code session each call `computer_click` and get the bridge stub's reply rather than a host refusal. **PR B checkpoint.** This check is PR B's merge condition.

### Task 11: The browser view (§4.2, D8, D9, D20, D21, D27)

**Files:** Create `app/src/main/computer/{browser,cdp,snapshot,mask}.ts`. Test `app/tests/unit/computer-{snapshot,mask,keys}.test.ts`; Task 16's e2e covers the live view.

**Interfaces:** Consumes `Target`, `Focus`, `navAllowed` (Tasks 2–3) and `AskInput` (Task 4). Produces:
```ts
export interface AxNode { nodeId: string; backendDOMNodeId?: number; role: string; name: string; value?: string; ignored: boolean; childIds: string[]; frameId?: string; inForm?: boolean; fileInput?: boolean }
export interface Snapshot { text: string; refs: Map<string, { backendNodeId: number; frameId?: string; target: Target }>; truncated: boolean }
export function formatSnapshot(nodes: AxNode[], o: { origin: string; url: string; title: string; sensitive: ReadonlySet<number>; cap: number }): Snapshot;
export interface Rect { x: number; y: number; width: number; height: number }
export function deviceRects(css: Rect[], o: { dpr: number; zoom: number; viewport: Rect }): Rect[];
export function paintRects(bgra: Buffer, width: number, height: number, rects: Rect[]): Buffer;
export function keyEvents(key: string): { type: "rawKeyDown" | "keyDown" | "char" | "keyUp"; key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string }[];
export interface TabInfo { index: number; url: string; title: string; openedBy: string | null; active: boolean }
export interface Resolved { target: Target; sensitive: boolean; backendNodeId: number | null; point: { x: number; y: number } }
export interface BrowserHooks { ask(i: Pick<AskInput, "why" | "title" | "detail" | "site">): Promise<boolean>; note(text: string): void; changed(): void }
export class ComputerBrowser {
  constructor(o: { key: string; window: () => BrowserWindow | null; hooks: BrowserHooks });
  tabs(): TabInfo[];  pageToken(): string;   // changes on every navigation of the active tab
  open(url: string, o: { newTab?: boolean; by: string | null }): Promise<{ url: string; title: string }>;
  snapshot(tab?: number): Promise<Snapshot>;  screenshot(tab?: number): Promise<Buffer>;
  resolve(by: { ref: string } | { x: number; y: number }): Promise<Resolved>;  focus(): Promise<Focus>;
  click(r: Resolved): Promise<void>;  type(text: string, keepGoing: () => boolean): Promise<void>;
  key(key: string): Promise<void>;  scroll(dx: number, dy: number, at?: Resolved): Promise<void>;
  show(bounds: Rect | null): void;  moveTo(win: BrowserWindow): void;  destroy(): void;
}
```
Decided behaviour:
- **Partition:** one shared `session.fromPartition("persist:computer")`, configured once.
  - `setPermissionCheckHandler(() => false)`.
  - `setPermissionRequestHandler` routes to `hooks.ask({ why: "permission" })`.
  - `will-download` pauses the item and asks `download`. Allow saves it to the Downloads folder under a unique name and notes the path; Deny cancels.
- **Tabs:** each is a `WebContentsView` with the Global Constraints' preferences.
  - `setWindowOpenHandler` denies; an allowed URL opens as a new tab, with a note.
  - `will-navigate`, `will-redirect` and `will-frame-navigate` call `preventDefault()` for any URL `navAllowed` refuses, with a note.
  - A navigation that `open()` didn't start is noted (D21).
- **Debugger:** call `debugger.attach("1.3")` per tab and enable `Page`, `DOM` and `Accessibility`. Turn on `Page.setInterceptFileChooserDialog`. On `Page.fileChooserOpened`, ask `file`; Allow shows the user an open dialog and passes the choice to `DOM.setFileInputFiles`.
- **Sensitive set (D9):** query on load, on `DOM.documentUpdated`, and on `DOM.childNodeInserted` (debounced to 100 ms). Use `DOM.getDocument({ depth: -1, pierce: true })` and `DOM.querySelectorAll` with `input[type="password" i], [autocomplete~="current-password" i], [autocomplete~="new-password" i], [autocomplete~="one-time-code" i]` across frames and shadow roots. `DOM.attributeModified` to `type=password` adds a field. Members stay for the document's life, so a Show-password reveal stays sensitive.
- **Snapshot:** call `Accessibility.getFullAXTree` per frame and pass it to `formatSnapshot`.
  - One line per named or roled node, such as `[e12] button "Merge pull request"`; sensitive values print as `••••••`.
  - The whole snapshot is wrapped as `<untrusted-page origin="…" url="…">…</untrusted-page>`.
  - The cap is 40,000 characters, ending with `[truncated: N more nodes]`.
- **Screenshot:** capture the viewport with `Page.captureScreenshot({ format: "png" })`. Sensitive boxes from `DOM.getBoxModel` go through `deviceRects` and are painted over with `paintRects` on the `nativeImage` bitmap.
- **Input:**
  - Click: scroll into view (`DOM.scrollIntoViewIfNeeded`), then `Input.dispatchMouseEvent` press and release at the box centre.
  - Type: `Input.insertText` in 200-character chunks, with each newline sent as Enter. `keepGoing()` runs before each chunk.
  - Key: `keyEvents`.
  - Scroll: a `mouseWheel` event.
- **Focus:** `DOM.querySelector(':focus')`. `plainTextarea` holds when the node is a `TEXTAREA` and `DOMDebugger.getEventListeners` finds no `keydown`, `keypress`, `keyup` or `beforeinput` listener on it or any ancestor.
- **show():** places the view at the pane's rectangle (CSS pixels times the HUD zoom). `null` uses Task 1's off-screen state.

- [ ] **Step 1: Write the failing tests:**
  - `formatSnapshot` redacts sensitive values, keeps refs and wraps with the origin.
  - `snapshot pierces frames and shadow roots`: nodes from two frames keep their `frameId`.
  - `snapshot caps size with a note`: 50,000 nodes give at most 40,000 characters in under 2 s.
  - `rects scale by device pixels and zoom`: dpr 2 at 125 % zoom.
  - `paintRects` changes exactly the rect's pixels.
  - `keyEvents` for `Shift+Tab`, `Control+a` and `Enter`.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3:** Implement the pure modules, then `ComputerBrowser`.
- [ ] **Step 4:** Run the unit tests and `(cd app && npm run typecheck)`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the computer browser view`.

### Task 12: The computer service (D3, D17, D21, D30–D32, D34, D35)

**Files:** Create `app/src/main/computer/service.ts`. Test `app/tests/unit/computer-service.test.ts` with a fake browser and clock.

**Interfaces:** Consumes Tasks 3, 4, 6, 8 and 11. Produces:
```ts
export interface LogLine { at: number; session: string; text: string }
export interface ComputerState { place: string; tabs: TabInfo[]; holder: Holder; asks: readonly Ask[]; log: readonly LogLine[]; marked: boolean; poppedOut: boolean }
export class ComputerService {
  constructor(o: { browser: (place: string) => ComputerBrowser; broker: AskBroker; wheel: Wheel; sites: SiteMarks; config: () => ComputerConfig; emit: (s: ComputerState) => void; note: (agent: AgentRef, line: string) => void });
  call(agent: AgentRef, call: ToolCall): Promise<Omit<ToolReply, "id">>;
  select(place: string | null): ComputerState | null;  show(bounds: Rect | null): void;
  navigate(url: string): Promise<Result<null>>;  tab(op: { kind: "new" } | { kind: "close" | "select"; index: number }): void;
  takeOver(): void;  handBack(): void;  answer(askId: string, a: Answer): void;  mark(origin: string, on: boolean): void;
  popOut(): void;  agentGone(agent: AgentRef): void;
}
```
Each call runs these steps:
1. Disabled config refuses: "The Computer pane is off (Settings › Computer)."
2. The computer is `agent.place` (D3, D30).
3. Look tools never take the wheel and work while another session drives. Acting tools `take` the wheel, or get "busy: <label> is driving" or "The user is driving: wait for Hand back."
4. Resolve the target and pass it to `judge`.
5. A verdict of go runs the action.
6. An ask goes to the broker with a title such as `Click “Merge pull request” on github.com?`.
7. Allow revalidates (same holder, same `pageToken`, same target role and name) and then runs the action. If anything differs, the reply is "The page changed while you waited: look again."
8. "always" on an `unmarked` ask marks the site; on a category ask it calls `allowCategory`. `return`, `file`, `download` and `permission` asks offer no Always.

Replies:
- **Snapshot:** the text as is.
- **Acting tools:** end with the page URL.
- **Deny:** "The user denied: <title>."
- **Waiting:** `waiting_for_user: call computer_wait with askId "<id>"`.
- **`computer_wait`:** `askId` waits on the broker; `text` re-reads the snapshot every 500 ms up to `timeoutSec`.
- **`computer_status`:** the place, the holder, the tabs, the session's access, whether the pane is on screen, and pending asks.

Take over cancels the place's pending asks and makes `keepGoing()` false. `agentGone` calls `wheel.turnEnded` and cancels that session's asks. `note()` reaches a Chat thread as a live `computer` timeline event (not written to the transcript file) and a Code session's place as an activity-log line (D35).

- [ ] **Step 1: Write the failing tests:**
  - A Read only click is refused, while a snapshot works.
  - A second session gets busy, and its look tools still answer.
  - An unmarked click asks; Deny leaves the fake page unclicked; Allow once clicks.
  - Always marks the site, so the next click goes.
  - Take over cancels a pending ask, and a late Allow does nothing.
  - `allowed action is dropped when the page changed`.
  - `turn end cancels the pending ask`.
  - `waiting_for_user` arrives at 45 s, and `computer_wait` gets the result.
  - `type` stops between chunks after Take over.
  - Disabled config refuses with the Settings line.
  - A page-started navigation writes a note.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3:** Implement the service.
- [ ] **Step 4:** Run the unit tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): route agent calls through the wheel and the gate`.

### Task 13: Wire it into the app, with ask notices (D27, D26)

**Files:** Create `app/src/main/computer/notify.ts`. Modify:
- `app/src/main/index.ts`: build the registry, broker, wheel, sites (`<userData>/computer/sites.json`), service and bridge; map `onAgent` and `spawnAgent`; replace the stub `handle`; shut down in `will-quit` and `endPageWork`; add the test-build switches.
- `app/src/shared/surfaces.ts`: the notify spawn.
- `app/src/main/services/sessions.ts`: `noteEvent(thread, text)` emits a `computer` session event.

Test `app/tests/unit/computer-notify.test.ts`.

**Interfaces:** Produces:
```ts
export class AskNotifier {
  constructor(o: { visible: (ask: Ask) => boolean; desktop: (title: string, body: string, onClick: () => void) => void; post: (title: string, body: string) => Promise<void>; reveal: (askId: string) => void });
  added(ask: Ask): void;   // off-screen only: a desktop notification and a Notifications item; clicking reveals the pane on it
}
export function testSwitches(env: NodeJS.ProcessEnv, packaged: boolean): { hostRules: string | null; trustedCli: string[] };
```
- **desktop:** Electron `Notification`.
- **post:** `node <vault>/brain/scripts/notify.js post --from computer --level info --title <t> --body-file -`, through the session service's runtime runner. `info` keeps the runtime from raising a second alert.
- **visible:** true when the pane shows that ask's place and has bounds.
- **Test builds:** `testSwitches` reads `AOS_E2E_HOST_RULES` (applied as `host-resolver-rules` before ready, so e2e gets unmarked `*.test` origins on 127.0.0.1) and `AOS_E2E_TRUSTED_CLI` (admission's `trusted`). Both are ignored when packaged.

- [ ] **Step 1: Write the failing tests:**
  - The notifier fires only off-screen, and a click reveals the ask.
  - A failed post is logged, never thrown.
  - `testSwitches(env, true)` returns nothing.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3:** Implement the notifier and the wiring.
- [ ] **Step 4:** Run `(cd app && npm run typecheck && npm run test:unit && npm run test:e2e)`. Expected: PASS, with the existing e2e unchanged.
- [ ] **Step 5:** Commit `feat(computer): wire the computer into the app with ask notices`. **PR C checkpoint.**

### Task 14: The `computer` page calls (D5, D32)

**Files:** Modify `app/src/shared/ipc.ts`, `app/src/preload/index.ts`, `app/src/main/ipc/schemas.ts`, `app/src/main/index.ts` (register), `app/src/renderer/bridgeHost.ts`, `hud/src/host.ts` (`HudHost.computer?: HostComputer`) and `app/tests/e2e/sandbox.spec.ts`. Create `app/src/main/ipc/computer.ts` and `app/src/main/policy/computer.ts`. Test `app/tests/unit/computer-ipc.test.ts`.

**Interfaces:** Consumes `ComputerService` (Task 12).

| Channel | Kind | `aos.computer.*` | Schema |
|---|---|---|---|
| `computer:select` | invoke | `select(place: string \| null): Promise<ComputerState \| null>` | place ≤ 512 or null, `placeAllowed` |
| `computer:show` | send | `show(bounds: Rect \| null)` | finite, 0–10000 |
| `computer:navigate` | invoke | `navigate(url): Promise<Result<null>>` | `UrlArgs`, `navAllowed` |
| `computer:tab` | send | `tab(op)` | discriminated union |
| `computer:take-over`, `computer:hand-back` | send | `takeOver()`, `handBack()` | none |
| `computer:answer` | send | `answer(askId, a)` | id ≤ 64; once, always or deny |
| `computer:mark` | send | `mark(origin, on)` | `siteOf` parses it |
| `computer:pop-out` | send | `popOut()` | none |
| `computer:event` | event | `onState(cb): () => void` | — |

`policy/computer.ts` holds `placeAllowed(place, vault)`: an existing workspace name, `vault`, `home`, or `dir:<absolute path>`. It also holds the bounds clamp.

- [ ] **Step 1: Write the failing tests:**
  - Each handler refuses a sender other than the main window.
  - The schemas reject bad input, including `navigate("javascript:…")` and `select("../x")`.
  - `sandbox.spec.ts` adds `"computer"` to the top list and pins `expect(shape.computer).toEqual(["answer", "handBack", "mark", "navigate", "onState", "popOut", "select", "show", "tab", "takeOver"])`.
- [ ] **Step 2:** Run the unit tests. Expected: FAIL.
- [ ] **Step 3:** Implement the channels, then map them in `bridgeHost` and `HudHost`.
- [ ] **Step 4:** Run the unit tests and `sandbox.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the computer page calls`.

### Task 15: The pane (D4, D5, D27, D32, D35)

**Files:** Create `hud/src/ui/ComputerPane.ts`, `hud/src/ui/ComputerAsk.ts` and `hud/src/ui/columnResize.ts`. Modify:
- `hud/src/ui/TerminalPanel.ts`: in the deck, mount the pane as the third child after `.aos-term-main`.
- `hud/src/views/SessionsTab.ts`: mount it after `.aos-ss-reader`, and add the row dot.
- `hud/src/views/WorkbenchView.ts`: badges for `term` and `chat`.
- `hud/src/ui/TermList.ts`: the row dot and the "waiting" badge.
- `hud/src/settingsDefaults.ts` (`computerPane`), `hud/styles.css`, and `app/obsidian-compat/src` if a new DOM helper or icon appears.

Test `hud/src/ui/ComputerPane.test.ts`, `hud/src/ui/columnResize.test.ts` and `hud/src/settingsDefaults.test.ts`.

**Interfaces:** Consumes `HostComputer` (Task 14). Produces:
```ts
export interface ComputerPaneSettings { width: number; collapsed: boolean }   // width 320–900, default 440
export function sanitizeComputerPane(v: unknown): Record<"code" | "chat", ComputerPaneSettings>;
export class ComputerPane {
  constructor(o: { host: HostComputer; page: "code" | "chat"; settings: () => ComputerPaneSettings; save: (s: ComputerPaneSettings) => void });
  mount(parent: HTMLElement): void;
  follow(sel: { place: string; label: string } | null): void;   // the selected terminal's placeKey, or the thread's workspace (D32)
  destroy(): void;
}
export function bindColumnResize(handle: HTMLElement, o: { min: number; max: number; get: () => number; set: (w: number) => void; done: (w: number) => void }): () => void;
```
Release-1 anatomy (D5), top to bottom:
1. **Header:** the Browser tab only, the workspace label, pop-out and collapse.
2. **Tab strip:** tabs with `+` and `×`.
3. **Address bar:** a `web` badge, and navigation for the user.
4. **View rectangle:** `data-tour="computer-view"`.
5. **Driving bar:** violet "<session> is driving" with Take over, or grey "You're driving" with Hand back.
6. **Ask cards** over the view: title, detail and site, with Allow once · Always on <site> · Deny. An unmarked ask says "Let it act freely on <site>", and Always is hidden for `return`, `file`, `download` and `permission`.
7. **Activity log** on the Code page.
8. **Footer** naming the acting session, plus a help link that states D29.

Behaviour:
- **Bounds:** a ResizeObserver on the rectangle and window resize call `host.show(rect)`. Collapsed, another rail tab, or a modal on top calls `show(null)`.
- **Pop-out (planner's call):** the native view moves to its own window, and the docked pane keeps its chrome and asks, with a "Popped out" placeholder.
- **Badges** count pending asks for the page's sessions. A row shows a dot while its session drives off-screen or has an ask; Code rows also show "waiting" (D35).
- **Narrow windows:** under 760 px, the pane starts collapsed.

- [ ] **Step 1: Write the failing tests** with a fake `HostComputer` and the HUD's fake DOM:
  - `follow()` selects the place, and collapsing sends `show(null)`.
  - The ask buttons send `once`, `always` and `deny`, and Always is hidden for `return`.
  - The driving-bar text matches each holder.
  - `bindColumnResize` clamps to 320–900 and calls `done` once.
  - `sanitizeComputerPane` rejects junk.
- [ ] **Step 2:** Run `npm test -w agentic-os`. Expected: FAIL.
- [ ] **Step 3:** Implement the pane, mount it on both pages, and add the badges and dots.
- [ ] **Step 4:** Run the HUD tests, `npm run typecheck` and `(cd app && npm run check:compat)`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(computer): add the Computer pane to the Code and Chat pages`.

### Task 16: End-to-end and the docs (§6 release 1, §5.7)

**Files:** Create `app/tests/e2e/computer.spec.ts` and `app/tests/e2e/fixtures/computer/*.html`. Modify:
- `app/tests/e2e/harness.ts`: the test-build switches, and a stub CLI that starts the launcher's MCP server and calls tools from a script.
- Docs: `docs/app-smoke.md`, `app/tests/e2e/COVERAGE.md` (rows and totals), `SECURITY.md` (a new section, "The Computer pane"), `README.md`, `app/README.md` and `CHANGELOG.md`.
- Tour: `hud/src/tour/steps.json`, `hud/src/tour/whatsnew.json` and `app/tests/e2e/tour.spec.ts`.

**e2e cases**, one per §6 release-1 bullet, run through the stub agent:
- **Basic flow:** on `http://shop.test:<port>`, the agent opens a page, snapshots it and clicks.
- **Unmarked site:**
  - A click asks; Deny leaves the page, and Allow proceeds.
  - A "Continue" button with a same-origin `fetch` POST asks before the POST; on Deny the server sees none.
  - Opening and scrolling don't ask.
  - Tab-then-Space onto a button asks.
  - `computer_type` into a field asks, tested apart from `computer_key`.
- **Marked origin:** "Merge pull request", "Sign in", a download, and Return in an ordinary form field each ask.
- **Schemes:** `javascript:`, `data:` and a redirect to `data:` are refused.
- **Passwords:** a password field is redacted in the snapshot and masked in the screenshot (checked by pixel), including after Show password.
- **Read only** snapshots but can't click.
- **Busy:** a second session gets busy.
- **Off-screen:** an ask raises the badge, and the notifier hook fires.
- **Take over** cancels a pending ask and stops the next action within 100 ms.
- **Outsiders:** a process the app didn't spawn is refused at hello.

**Docs:**
- `SECURITY.md` covers:
  - the view: partition, no preload, schemes;
  - the socket and admission: spawn ownership, install forms, first connection wins, hand-started CLIs refused;
  - the gate's guarantee and what it accepts: an opened URL can trigger a GET effect; secrets shown as page text aren't caught; other browser tools act without the pane (D29); marked sites are best effort;
  - Codex parity per Task 1.
- The changelog's Added bullet is `- **Computer pane.** … <!-- tour: code.computer, chat.computer -->`.
- New steps `code.computer` and `chat.computer` anchor on `[data-tour="computer-view"]` with `"since": "2.5.0"`, plus a 2.5.0 What's new entry.
- `app-smoke.md` gets an item per host for a Chat turn and a Code session; the matching `COVERAGE.md` rows read `manual` until Task 17.

- [ ] **Step 1:** Write `computer.spec.ts` and the fixtures. Run `(cd app && npm run test:e2e -- computer.spec.ts)`. Expected: FAIL only where wiring is missing; fix in place.
- [ ] **Step 2:** Run the whole e2e suite and `node tools/changelog.js check current`. Expected: PASS.
- [ ] **Step 3:** Write the docs, tour steps and coverage rows. Run `tour.spec.ts` and the gate. Expected: PASS.
- [ ] **Step 4:** Commit `test(computer): cover release 1 end to end` and `docs(computer): document the Computer pane`.

### Task 17: Prove it and hand over

- [ ] **Step 1:** Run the spec's proof block (§6, without the packaged pair) and the parity check with rehearsals. Expected: all green.
- [ ] **Step 2:** Run the live check per host (D33, D26), with the owner's OK. On Claude Code and Codex, a Chat turn and a Code session each open a page, snapshot it, and click through an ask. Record the results in the PR D body, and flip the `computer` surface to `verified: true` only for what passed.
- [ ] **Step 3:** Run the publish check, then have the provider that didn't build inspect the four PRs' combined diff in a fresh session. Fix and re-inspect per the cross-review loop. **PR D checkpoint.**
