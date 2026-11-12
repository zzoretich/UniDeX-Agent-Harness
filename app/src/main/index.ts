// Main process: the Workbench window, the menubar item, the app menu, agenticos:// links and the vault watcher. The app
// attaches to the vault an existing AgenticOS install uses (agenticos.json); with none, the page shows the first-run
// wizard, which runs `aos init` from the runtime the app carries (./setup, phase 5) and then attaches the vault it made
// without a relaunch. The page runs sandboxed with no Node (phase 4): every file it reads or writes, every process and
// terminal it starts and everything it hands to the OS goes through the preload's bridge to the handlers in ./ipc, which
// check it against the read scope, the write surfaces and the program rules (./policy). Main itself writes one file
// outside its userData: the app's record in the vault's runtime cache (hud-host.ts). The app updates itself (./updater).

import { app, autoUpdater, BrowserWindow, dialog, Menu, nativeTheme, net, Notification, screen, shell, type Rectangle } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_ORIGIN, CH, POPOVER, type AttachInfo, type BootInfo, type CommandInfo, type ComputerEvent, type ProtocolRequest, type ReadyInfo, type ThemeSource, type ThemeState } from "../shared/ipc";
import { registerAppScheme, serveAppScheme } from "./app-scheme";
import { BRAND } from "../shared/brand";
import type { Sys } from "./computer/admission";
import { AskBroker } from "./computer/asks";
import { ComputerBrowser } from "./computer/browser";
import { computerConfig, type ComputerConfig } from "./computer/config";
import { AskNotifier, testSwitches } from "./computer/notify";
import { loadPeer, type PeerAddon } from "./computer/peer";
import { AgentRegistry } from "./computer/registry";
import { BrowserRecords } from "./computer/records";
import { ComputerService } from "./computer/service";
import { SiteMarks } from "./computer/sites";
import { Wheel } from "./computer/wheel";
import { START_PAGE } from "../../../hud/src/data/computerStart";
import { writeHudHostMarker, type HudHostInfo } from "./hud-host";
import { registerFsIpc } from "./ipc/fs";
import { registerHostIpc } from "./ipc/host";
import { registerProcIpc } from "./ipc/proc";
import { registerProposalsIpc } from "./ipc/proposals";
import { registerCodeIpc } from "./ipc/code";
import { registerSessionIpc } from "./ipc/sessions";
import { registerSetupIpc, registerUpdateIpc } from "./ipc/setup";
import { externalOpens, openExternalSafe, registerShellIpc } from "./ipc/shell";
import { registerComputerIpc } from "./ipc/computer";
import { registerThemeIpc } from "./ipc/theme";
import { trustMainWindow } from "./ipc/trust";
import { buildAppMenu } from "./menu";
import { debugSwitches } from "./policy/debug";
import { parseShells, type ProgramContext } from "./policy/programs";
import { ReadScope, type AgenticosPaths } from "./policy/read-scope";
import { WritePolicy } from "./policy/write-policy";
import { SCHEME, parseAgenticosUrl, urlFromArgv } from "./protocol";
import { quitGate, quitCalledOff } from "./quit-gate";
import { admit } from "./computer/admission";
import { BridgeKeeper, ComputerBridge, bridgeSocketPath } from "./computer/bridge";
import { ComputerDoor, doorSocketPath, openerPath } from "./computer/door";
import { sweepHeld } from "./computer/downloads";
import { FsService } from "./services/fs";
import { ProcService } from "./services/proc";
import { GitService } from "./services/git";
import { CodeGitService } from "./services/code-git";
import { CodeImageService } from "./services/code-images";
import { CodeMirrorService } from "./services/code-mirror";
import { PtyService, terminalBaseEnv, type PtyLib } from "./services/pty";
import { SessionService, workspaceDir } from "./services/sessions";
import { attachInfo, hostsOf } from "./setup/attach";
import { SetupController, type AgenticosJson } from "./setup/controller";
import { defaultLoginPathDeps, findOnPath, isExecutable, loginPath, loginShellEnv } from "./setup/env";
import { FlagProbe } from "./services/cli-flags";
import { findPayload } from "./setup/payload";
import { loadThemeSource, saveThemeSource, windowBackground } from "./theme";
import { STATUSLINE_PATH, StatusTray } from "./tray";
import { UpdateService, updatesConfig, updatesWanted, type UpdaterLike } from "./updater";
import { VaultWatcher } from "./watcher";
import { loadWindowState, trackWindowState } from "./window-state";
import { loadWriteSettings } from "./write-settings";

export type { BootInfo };

// A packaged release refuses to be debugged from outside (S8): a debugger would hand whoever started the app everything
// it may do, its macOS permissions included. Chromium starts its DevTools server only once this script has run, so
// leaving here keeps it from ever listening. The smoke build (`npm run dist:test`) is the one packaged build that allows it.
const debugging = debugSwitches(process.argv);
if (debugging.length && app.isPackaged && !__AOS_TEST_BUILD__) {
  console.error(`[main] refusing to start with ${debugging.join(", ")}: this build cannot be debugged from outside`);
  process.exit(1);
}

// agent-computer D18, D39: the e2e suite's switches, which a packaged build ignores (computer/notify.ts testSwitches).
// Chromium reads its switches before `ready`: the host rules give the suite's fixture sites unmarked *.test origins.
const e2e = testSwitches(process.env, app.isPackaged);
if (e2e.hostRules) app.commandLine.appendSwitch("host-resolver-rules", e2e.hostRules);
/** The Computer pane's start page: DuckDuckGo, or the e2e suite's fixture (a test seam: AOS_E2E_START_PAGE). Main opens it
 *  for the pane's + and hands it to the page, whose address bar searches it. */
const computerStartPage = e2e.startPage ?? START_PAGE;

/** The install's agenticos.json (the launcher's lookup): its path, and what `aos init` / `aos upgrade` wrote there. */
const agenticosFile = process.env.AOS_CONFIG || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "agenticos.json");
type Agenticos = AgenticosPaths & AgenticosJson & { vault?: string };
function readAgenticos(): Agenticos | null {
  try { return JSON.parse(fs.readFileSync(agenticosFile, "utf8")) as Agenticos; } catch { return null; }
}
let agenticos = readAgenticos();

/** The vault an existing install points at: $AOS_APP_VAULT, else agenticos.json's `vault` when that folder is there. */
function resolveVault(): { root: string | null; source: string; configured: string | null } {
  if (process.env.AOS_APP_VAULT) return { root: process.env.AOS_APP_VAULT, source: "AOS_APP_VAULT", configured: process.env.AOS_APP_VAULT };
  const v = typeof agenticos?.vault === "string" ? agenticos.vault : null;
  return { root: v && fs.existsSync(v) ? v : null, source: agenticosFile, configured: v };
}

const dev = !app.isPackaged;
// The app's name is package.json's productName (UniDeX spec D2: UniDeX); the data folder keeps its old name (D1). A dev run keeps its data apart from the
// packaged app's, so the two can run side by side; tests point it at a temp folder.
app.setPath("userData", process.env.AOS_APP_USER_DATA || path.join(app.getPath("appData"), dev ? "AgenticOS Workbench (dev)" : "AgenticOS Workbench"));
// The app's page comes from app://hud (app-scheme.ts), which must be registered before `ready`.
registerAppScheme();
// Light and dark (UniDeX D6): the saved choice, set before any window exists so the first frame is drawn in it.
nativeTheme.themeSource = loadThemeSource(app.getPath("userData"));

let vault = resolveVault();
const writes = loadWriteSettings();
// The runtime the app carries (phase 5, I1): what the wizard installs and attach mode upgrades from.
const payload = findPayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env });

// session-browser S23: the door a program inside a session knocks on to open a page in that session's browser, and the
// opener it knocks with. The opener ships under Resources when packaged; a development run reads it from app/resources.
// No door when no socket path fits; no opener, and no session gets the variables. It starts with the bridge (makeBridge).
const doorPath = doorSocketPath(app.getPath("userData"), app.getPath("temp"));
const computerDoor = doorPath ? new ComputerDoor({
  path: doorPath,
  opener: openerPath({ resources: app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../resources"), tmp: app.getPath("temp"), userData: app.getPath("userData") }),
  // Task 18 opens the page; until then a program's request is only noted (never its address).
  open: (session) => console.warn(`[main] door: ${session} asked for a page`),
  log: (line) => console.warn(`[main] ${line}`),
}) : null;
/** The opener variables of a session's processes: none while the Computer surface is off or there is no door. */
const browserEnv = (session: string, base: NodeJS.ProcessEnv): Record<string, string> => (computerOn() ? computerDoor?.envFor(session, base) ?? {} : {});

let shells: string[] = [];
try { shells = parseShells(fs.readFileSync("/etc/shells", "utf8")); } catch { /* no /etc/shells: only $SHELL */ }
const context: ProgramContext = {
  // agenticos.json's install paths (`aos config set` cannot change them): the Claude and Codex folders main trusts.
  vaultRoot: vault.root, home: os.homedir(), userData: app.getPath("userData"), env: process.env, agenticos, shells,
};
// The vault-bound services: replaced when the wizard's install attaches a vault (attachVault).
let policy = new WritePolicy(vault.root, writes.surfaces);
let scope = new ReadScope(context);
let fsService = vault.root ? new FsService({ vaultRoot: vault.root, userData: context.userData, scope: () => scope, policy: () => policy }) : null;
let attached: AttachInfo | null = null;
const procService = new ProcService({ policy: () => policy, context: () => context, env: process.env, emit: (ev) => send(CH.procEvent, ev) });
// agent-computer D18: the agent CLIs this app spawned (a Chat turn's, a Code launch's), which the computer bridge admits
// from, and the peer addon's checks behind it: one registry and one Sys for the app's life (launchForm caches per Sys).
// Without the addon every Code launch falls back to the typed line in a shell, and says so.
const agentRegistry = new AgentRegistry();
let computerPeer: PeerAddon | null = null;
const computerSys: Sys | null = (() => {
  try {
    const peer = (computerPeer = loadPeer());
    return {
      procInfo: (pid) => peer.procInfo(pid), teamId: (p) => peer.teamId(p), processTeamId: (pid) => peer.processTeamId(pid),
      realpath: (p) => fs.realpathSync(p), stat: (p) => fs.statSync(p),
    };
  } catch (err) {
    console.warn(`[main] the peer addon did not load, so agents run without the computer: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return null;
  }
})();
// The app's own node-pty: in a packaged build its JavaScript is in the archive and its native parts are unpacked beside it.
// Its terminals start with the login shell's PATH (T14), worked out once and shared with sessionNode. While the computer
// surface is on, a Code launch's agent runs as its terminal's own process, from the binary the runtime resolves (D18),
// with the environment the login shell gives a typed command (C1); off, the launch is typed into a shell as before.
const noDaemonProbe = new FlagProbe("--no-daemon");
const ptyService = new PtyService({
  context: () => context, env: () => terminalBaseEnv(process.env, termPATH()), emit: (ev) => send(CH.ptyEvent, ev), load: () => require("node-pty") as PtyLib,
  computerOn: () => computerOn(), shellEnv: (shell, cwd, base) => loginShellEnv(shell, cwd, base),
  resolveBin: (host) => sessionService.resolveBin(host), registry: agentRegistry, sys: computerSys, trusted: e2e.trustedCli,
  // agent-computer R70: a Codex launch runs without Codex's shared background server when its CLI's help lists the flag
  // (the help read with the launch's environment, R77).
  noDaemon: (bin, env, sub) => noDaemonProbe.lists(bin, { env, sub }),
  // ...and only while Settings ▸ Computer is on as well as the surface (R77).
  computerEnabled: () => computerSettings().enabled,
  // Nothing is resolved or probed for Codex while agenticos.json has it off (R77), read fresh as a host change lands.
  hostOn: (host) => hostsOf(readAgenticos())[host],
  // agent-computer D31: a Code agent that exits (or whose terminal closes) frees its computer's wheel and cancels its asks.
  onAgentGone: (agent) => computerService.agentGone(agent),
  // R86: no terminal starts while the app quits (quit-gate.ts), so the quit's wait for their exits is the last one.
  quitting: () => quitting,
  browserEnv,
  // code-chat R16: a terminal's transcript follower ends when the terminal is closed, not when its agent exits.
  // session-browser S22: closing a row forgets its browser, named by the terminal's FIRST process (a takeover shell's close
  // reports it); the page going ("all") forgets nothing here, `pageGone` handles that.
  onEnd: (id, terminal, why, origin) => {
    codeMirror.end(id, terminal);
    if (why === "closed") {
      computerService.forget(`code:${origin}`);
      // The session ended: its id stops working. Never tied to `destroyed`: turning a browser off keeps the id valid.
      computerDoor?.revoke(`code:${origin}`);
    }
  },
});
// Agent sessions (UniDeX phase 2) and the workspace repositories they change: main's own services, behind the Sessions
// surface. A turn outlives a page reload; quitting stops every one.
const sessionsOn = (): boolean => policy.ids.includes("sessions");
// agent-computer D26: the computer runs only while its surface is on (the bridge and the ask notices' post); on by
// default since its live check on each host. `computer.enabled` is the person's switch inside it (D25).
const computerOn = (): boolean => policy.ids.includes("computer");
let loginPATH: string | null = null;
/** The login shell's PATH, asked once (setup/env.ts loginPath; $AOS_SETUP_PATH stands in for it under e2e). */
function termPATH(): string {
  loginPATH ??= loginPath(defaultLoginPathDeps(process.env, os.homedir()));
  return loginPATH;
}
/** The node the runtime's scripts run with: agenticos.json's (aos init records it), else the login shell's. */
function sessionNode(): string | null {
  const recorded = agenticos?.node;
  if (typeof recorded === "string" && isExecutable(recorded)) return recorded;
  return findOnPath("node", termPATH());
}
const sessionService = new SessionService({
  trash: (file) => shell.trashItem(file),
  onRemoved: (thread) => { computerService.forget(`chat:${thread}`); computerDoor?.revoke(`chat:${thread}`); },
  browserEnv,
  vaultRoot: () => context.vaultRoot ?? null, enabled: sessionsOn, computerOn, context: () => context, env: process.env, node: sessionNode,
  // A turn's start and end are when a thread's title may have changed: the browser's label is read again then, not on every state.
  emit: (ev) => { send(CH.sessionEvent, ev); if (ev.event.kind === "prompt" || ev.event.kind === "done") computerService.retitled(`chat:${ev.thread}`); },
  // A Code launch's binary is the one its terminal's PATH finds, as the typed line's was (agent-computer D18).
  terminalPATH: () => termPATH(),
  // A Chat turn's CLI is registered while it runs, under its thread's key (`chat:<thread>`: its own browser, session-browser
  // S1, which supersedes the folder-wide computer of agent-computer D3 and D30); its place is only the folder's label.
  // Its exit ends the turn on the computer too: the wheel frees and its asks are cancelled (D31).
  onAgent: (ev) => {
    if (ev.kind === "start") { agentRegistry.add({ pid: ev.pid, host: ev.host, page: "chat", key: `chat:${ev.thread}`, label: ev.title, place: `ws:${ev.workspace}`, access: ev.access }); return; }
    const ref = agentRegistry.get(ev.pid);
    if (ref?.key !== `chat:${ev.thread}`) return;
    agentRegistry.remove(ev.pid);
    computerService.agentGone(ref);
  },
});
// The Code chat view's transcript followers (spec 2026-11-09-code-chat), behind the Code chat surface: one per agent
// terminal, ended with it; quitting stops every one.
const codeChatOn = (): boolean => policy.ids.includes("code");
const codeMirror = new CodeMirrorService({
  vaultRoot: () => context.vaultRoot ?? null, enabled: codeChatOn, context: () => context, env: process.env, node: sessionNode,
  ptyInfo: (id) => ptyService.info(id),
});
const gitService = new GitService({ workspace: (name) => workspaceDir(context.vaultRoot ?? null, name), enabled: sessionsOn, env: process.env });
// The Code tab's Diff (code-chat C8): read-only git in the folder main picks from the terminal's own cwd, whichever write
// surfaces are on.
const codeGit = new CodeGitService({ vaultRoot: () => context.vaultRoot ?? null, ptyInfo: (id) => ptyService.info(id), git: gitService });
// The Code composer's images (code-chat C7, C13, R59): saved into the app's own data folder, behind the Code chat surface,
// within its quota; retention runs once the app is ready.
const codeImages = new CodeImageService({ userData: () => context.userData, enabled: codeChatOn });

// agent-computer D3, D7, D27, D31, D34, D35: the computer behind the bridge. One ask broker, one wheel, the marked sites
// (<userData>/computer/sites.json), and a browser per session (session-browser S1), made on its first use (after ready:
// the bridge starts only then). Its state, and the reveal a notification's click asks for, reach the page on `computer:event`; a Chat agent's
// lines reach its thread live. An ask the pane does not show raises a desktop notification and a Notifications item.
const computerSettings = (): ComputerConfig => computerConfig(vault.root, agenticosFile);
const computerBrowsers = new Map<string, ComputerBrowser>();
/** The notices raised off-screen, newest last, for the e2e suite (`__aosMain.computerNotices`). */
const computerNotices: Array<{ title: string; body: string }> = [];
const askNotifier = new AskNotifier({
  visible: (ask) => (ask.why === "power" ? computerService.paneShows(ask.computer) && computerWindowShown(true) : computerService.onScreen(ask.computer) && computerWindowShown()),
  desktop: (title, body, onClick) => {
    if (!app.isPackaged || __AOS_TEST_BUILD__) {
      computerNotices.push({ title, body });
      if (computerNotices.length > 50) computerNotices.shift();
    }
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on("click", onClick);
    n.show();
    // Held until the ask settles (the notifier withdraws it then), so its click handler stays alive.
    return () => n.close();
  },
  post: (title, body) => sessionService.postComputerNotice(title, body),
  reveal: (askId) => { show(); sendComputerEvent({ type: "reveal", askId }); },
});
const askBroker = new AskBroker({
  timeoutMs: () => computerSettings().askTimeoutSec * 1000,
  onChange: (pending) => { computerService.refresh(); computerService.released(); askNotifier.sync(pending); },
});
const computerWheel = new Wheel({ reserved: (c) => computerService.reserved(c), onChange: () => { computerService.refresh(); computerService.released(); } });
/** An ask the person could see when it came is noticed if the app's window blurs, hides or minimizes while it is pending. */
const recheckAsks = (): void => { setTimeout(() => askNotifier.sync(askBroker.pending()), 0); };
const computerRecords = new BrowserRecords({
  file: path.join(app.getPath("userData"), "computer", "browsers.json"),
  log: (line) => console.warn(`[main] ${line}`),
});
const computerService: ComputerService = new ComputerService({
  records: computerRecords,
  threadExists: (session) => session.startsWith("chat:") ? sessionService.exists(session.slice("chat:".length)) : false,
  // `moved` fires only for a move that answered true (service.ts move): the replacement terminal's own id stays valid and
  // the old terminal's ids now name it too.
  moved: (from, to) => { const b = computerBrowsers.get(from); if (b) { computerBrowsers.delete(from); computerBrowsers.set(to, b); } computerDoor?.move(from, to); },
  label: (session) => (session.startsWith("chat:") ? sessionService.titleOf(session.slice("chat:".length)) : undefined),
  browser: (session, hooks) => {
    const b = new ComputerBrowser({ key: session, window: () => win, hooks });
    computerBrowsers.set(session, b);
    return b;
  },
  destroyed: (session) => {
    // A destroyed browser is not moved home (session-browser S21): the pop-out forgets it and shows nothing until told.
    const b = computerBrowsers.get(session);
    computerBrowsers.delete(session);
    if (b && computerPop?.view === b) computerPop.view = null;
  },
  broker: askBroker,
  wheel: computerWheel,
  sites: new SiteMarks(path.join(app.getPath("userData"), "computer", "sites.json")),
  config: computerSettings,
  emit: (state) => sendComputerEvent({ type: "state", state }),
  // D35: a Chat agent's line joins its thread's timeline, live; a Code agent's stays in the pane's activity log (the
  // service keeps it there) and its tool results. The app never writes into a terminal.
  note: (agent, line) => {
    if (agent.page === "chat" && agent.key.startsWith("chat:")) sessionService.noteEvent(agent.key.slice("chat:".length), line);
  },
  popOut: (session, show) => popOutComputer(session, show),
  // D31: a late bridge close from a session's previous process must not end the turn that replaced it.
  liveAgent: (key) => agentRegistry.byKey(key),
  startPage: computerStartPage,
});
// The records are read once the app is ready, not here: a thread's browser that was on is restored through Electron's
// session API, which throws before `ready` (session-browser S6, S7). See `restoreComputer`, called first in `whenReady`.
/** Once, independent of the bridge (no vault, a failed peer addon, the surface off at start) and before the window and
 *  before any page call: the Code records become orphans before any new terminal can reuse a key, and the threads'
 *  browsers come back asleep or off. One bad record must never stop the app from starting. */
function restoreComputer(): void {
  try {
    computerRecords.orphanCode();
    computerService.boot();
  } catch (err) {
    console.warn("[main] computer: saved browsers could not be restored", err);
  }
}

/** The variables the HUD reads (HudHost.env), from main's environment; nothing else of it reaches the page. */
const PAGE_ENV = ["SHELL", "CLAUDE_CONFIG_DIR", "AOS_CONFIG", "AOS_VAULT", "CODEX_HOME"];

/** What the page boots with: the vault (or why there is none, for the wizard), attach mode's facts, the updater's state. */
function bootInfo(): BootInfo {
  return {
    vaultRoot: vault.root,
    vaultSource: vault.source,
    userData: app.getPath("userData"),
    writeSurfaces: writes.surfaces,
    writeSource: writes.source,
    mainWatcher: !!vault.root,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    home: os.homedir(),
    platform: process.platform,
    env: Object.fromEntries(PAGE_ENV.flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k] as string]] : []))),
    resourcesPath: process.resourcesPath,
    setup: vault.root ? null : {
      reason: vault.configured ? "no-vault" : "no-config",
      payload: payload ? { version: payload.version, runtimeDeps: payload.runtimeDeps } : null,
      configuredVault: vault.configured,
      defaultVault: path.join(os.homedir(), "AgenticOS"),
      agenticosFile,
    },
    attach: attached,
    update: updates.state,
    theme: themeState(),
    computerStartPage,
  };
}

let win: BrowserWindow | null = null;
let tray: StatusTray | null = null;
let watcher: VaultWatcher | null = null;
let quitting = false;
let rendererReady = false;
let commands: CommandInfo[] = [];
const pendingLinks: ProtocolRequest[] = [];

// The app's own updates (phase 5, I6): a packaged release build only, and never against the runtime's updates.check.
const updateConfig = updatesConfig(vault.root, agenticosFile);
const updates = new UpdateService({
  ...updatesWanted({ packaged: app.isPackaged, testBuild: __AOS_TEST_BUILD__, env: process.env, config: updateConfig }),
  intervalHours: updateConfig.intervalHours,
  load: () => (require("electron-updater") as { autoUpdater: UpdaterLike }).autoUpdater,
  emit: (s) => {
    if (quitCalledOff({ quitting, updateStatus: s.status })) { quitting = false; computerService.quitCancelled(); }
    send(CH.updateEvent, s);
    setMenu();
  },
  // The window hides on close until the app quits; an update's quit closes the windows before `before-quit`, so it says so first.
  beforeInstall: () => { quitting = true; shutdownComputer(); },
  // R86: the terminals end, and node-pty reports each exit, before quitAndInstall starts the quit (quit-gate.ts).
  settle: () => (ptyService.busy ? ptyService.settle() : null),
});
/** R86: a quit with a terminal running waits until node-pty has reported every terminal's exit, about a second at most. */
const gate = quitGate({ busy: () => ptyService.busy, settle: () => ptyService.settle(), quit: () => app.quit() });
/** How many times the page asked to restart into an update (the e2e suite reads it: a dev run has no update to install). */
let installRequests = 0;

/** Only our own page, in our own window's main frame, may talk to main. */
const trust = trustMainWindow(() => win);

/** The only way `computer:event` is sent: the payload is a ComputerEvent. */
function sendComputerEvent(ev: ComputerEvent): void { send(CH.computerEvent, ev); }

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── the tray popover ─────────────────────────────────────────────────

const POPOVER_SIZE = { width: 380, height: 640 };
const POPOVER_OPTIONS: Electron.BrowserWindowConstructorOptions = {
  ...POPOVER_SIZE, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
  fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: BRAND.name,
};
let popover: BrowserWindow | null = null;

/** Shows the popover under the tray icon (or hides it). False when there is none yet: the tray shows its menu. */
function togglePopover(anchor: Rectangle): boolean {
  if (!popover || popover.isDestroyed()) return false;
  if (popover.isVisible()) { popover.hide(); return true; }
  const area = screen.getDisplayMatching(anchor).workArea;
  const x = Math.round(Math.min(Math.max(anchor.x + anchor.width / 2 - POPOVER_SIZE.width / 2, area.x + 4), area.x + area.width - POPOVER_SIZE.width - 4));
  // Under a menubar icon; above one in a bottom bar.
  const below = anchor.y < area.y + area.height / 2;
  const y = Math.round(below ? Math.max(anchor.y + anchor.height + 4, area.y) : anchor.y - POPOVER_SIZE.height - 4);
  popover.setPosition(x, y);
  popover.show();
  popover.focus();
  return true;
}

// ── the computer's pop-out window ────────────────────────────────────

/** The pop-out window, the session it follows (session-browser S21: null when none is selected) and the browser object in
 *  it (null while it is empty). Agent-computer D5: the pane's Pop out. */
let computerPop: { win: BrowserWindow; session: string | null; view: ComputerBrowser | null } | null = null;

const popBounds = (w: BrowserWindow): Rectangle => { const [width, height] = w.getContentSize(); return { x: 0, y: 0, width, height }; };

/** A computer back in the main window, or parked when there is none (it keeps painting off-screen, D27). */
function moveHome(b: ComputerBrowser | undefined): void {
  if (!b) return;
  if (win && !win.isDestroyed()) b.moveTo(win); else b.show(null);
}

/** The pop-out window is closing: its computer goes back first, since a view has no host once its window is gone. */
function popBack(): void {
  const pop = computerPop;
  if (!pop) return;
  computerPop = null;
  moveHome(pop.view ?? undefined);
  computerService.popIn();
}

/** Closes the pop-out window, its computer moved back first (the page went: nothing would show it). */
function closeComputerPop(): void {
  const w = computerPop?.win;
  popBack();
  if (w && !w.isDestroyed()) w.destroy();
}

/**
 * The pop-out window follows the selected session (session-browser S21). `on` with a browser: that browser goes into the
 * window (made on first use; the one held before goes back to the main window; the same object only retitles it).
 * Otherwise (the session's browser is off, or none is selected) the window stays open and empty and its title says so.
 * The window loads nothing and has no preload: it only holds the view, with the main window's hardening. Later calls never
 * show or focus the window, except the user's own Pop out press (`front`), which brings an existing window forward. Closing it moves the view back to the main window first.
 */
function popOutComputer(session: string | null, show: { label: string; on: boolean; front?: boolean }): void {
  const b = session && show.on ? computerBrowsers.get(session) : undefined;
  let pop = computerPop && !computerPop.win.isDestroyed() ? computerPop : null;
  let created = false;
  if (!pop) {
    if (!b) return;
    const w = new BrowserWindow({
      width: 1100, height: 760, minWidth: 480, minHeight: 360, show: false, title: `${BRAND.name} Browser`,
      backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
      webPreferences: {
        nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, backgroundThrottling: false,
      },
    });
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.on("resize", () => { if (computerPop?.win === w) computerPop.view?.show(popBounds(w)); });
    w.on("close", () => { if (computerPop?.win === w) popBack(); });
    w.on("blur", recheckAsks);
    w.on("hide", recheckAsks);
    w.on("minimize", recheckAsks);
    pop = computerPop = { win: w, session, view: null };
    created = true;
  }
  pop.session = session;
  // Another session's browser, or this session's new one (turned off and on again): the one held goes home first.
  if (pop.view && pop.view !== b) { moveHome(pop.view); pop.view = null; }
  if (b && pop.view !== b) {
    b.moveTo(pop.win);
    pop.view = b;
    b.show(popBounds(pop.win));
  }
  pop.win.setTitle(`${BRAND.name} Browser${session && show.label ? `: ${show.label}` : ""}${session && !show.on ? " (off)" : ""}`);
  if (created) { pop.win.show(); pop.win.focus(); }
  else if (show.front) { if (pop.win.isMinimized()) pop.win.restore(); pop.win.show(); pop.win.focus(); }
}

/**
 * Whether the person can see the pane's computer now (agent-computer D27): the window holding it (the pop-out while
 * there is one, else the main one) is shown and not minimized, and one of the app's windows has focus (the main one,
 * where the ask's card is, or the pop-out). `inMain`: a power ask's card is always in the main window's pane, so the
 * main window is the holder; either window's focus counts.
 */
function computerWindowShown(inMain = false): boolean {
  const pop = computerPop && !computerPop.win.isDestroyed() ? computerPop.win : null;
  const holder = inMain ? win : (pop ?? win);
  if (!holder || holder.isDestroyed() || !holder.isVisible() || holder.isMinimized()) return false;
  return [win, pop].some((w) => !!w && !w.isDestroyed() && w.isFocused());
}

/**
 * As soon as the app starts quitting (before-quit, before-quit-for-update, an update's install): every computer's views
 * and the park window go (ComputerBrowser.destroy also drops its window watchers, so nothing re-places a view), and the
 * pop-out window. Nothing may create a window once quitting starts: a window made while the others close (a park window,
 * for a view whose window went) keeps will-quit from ever firing. The service makes new browsers if the app goes on (an
 * update's quit that failed).
 */
function shutdownComputer(): void {
  // The records first: a write still waiting for its 500 ms goes out before the browsers are destroyed.
  // Closes the records: nothing the shutdown does next (destroying browsers, cancelling asks) may rewrite them, and it
  // may run twice (before-quit, will-quit). A quit that fails reopens them when a browser is next made.
  computerService.flushForQuit();
  // The door goes with the browsers it opens pages in; stopping twice does nothing (the bridge's stop does it as well).
  computerDoor?.stop();
  for (const b of computerBrowsers.values()) { try { b.destroy(); } catch { /* already gone */ } }
  computerBrowsers.clear();
  computerService.forgetBrowsers();
  const pop = computerPop;
  computerPop = null;
  if (pop && !pop.win.isDestroyed()) pop.win.destroy();
}

function show(): void {
  // Nothing may create a window once quitting starts (shutdownComputer): a held quit (R86) can find the windows gone.
  if (!win) { if (!quitting) createWindow(); }
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function runCommand(id: string): void {
  show();
  send(CH.command, id);
}

function openLink(url: string): void {
  const req = parseAgenticosUrl(url);
  if (!req) { console.warn(`[main] ignored link ${url}`); return; }
  show();
  if (rendererReady) send(CH.protocol, req);
  else pendingLinks.push(req);
}

function setMenu(): void {
  Menu.setApplicationMenu(buildAppMenu(commands, runCommand, {
    dev, setup: rendererReady && !vault.root,
    update: { state: updates.state, check: () => updates.check(), install: () => updates.install() },
    theme: { source: nativeTheme.themeSource as ThemeSource, set: (source) => { setTheme(source); } },
  }));
}

// ── light and dark ───────────────────────────────────────────────────

function themeState(): ThemeState {
  return { source: nativeTheme.themeSource as ThemeSource, dark: nativeTheme.shouldUseDarkColors };
}

/** Tells the page, repaints the windows' backgrounds and re-checks the menu's Appearance item. */
function broadcastTheme(): void {
  const s = themeState();
  for (const w of [win, popover, computerPop?.win]) if (w && !w.isDestroyed()) w.setBackgroundColor(windowBackground(s.dark));
  send(CH.themeEvent, s);
  setMenu();
}

/** Applies and saves the user's choice. nativeTheme says nothing when the colours stay the same, so this always tells. */
function setTheme(source: ThemeSource): ThemeState {
  nativeTheme.themeSource = source;
  try { saveThemeSource(app.getPath("userData"), source); } catch (err) { console.error("[main] could not save the theme", err); }
  broadcastTheme();
  return themeState();
}

// agent-computer D18, D26: the bridge socket the agent CLIs' MCP servers connect to. One for the attached vault, only when
// the peer addon loaded and while the computer surface is on. Every admitted call goes to the computer service; a closed
// connection ends its agent's hold (D31).
const bridges = new BridgeKeeper({
  make: (root) => makeBridge(root),
  // The surface is on but no bridge listens: the vault's marker says so, so the agents' tools say so too.
  onFail: (root) => recordApp(root, { computerFailed: true }),
});

/** The app's record in a vault (D11) with main's pid and the Computer pane's state (agent-computer D26). Informational:
 *  a vault the app cannot write to still opens. */
function recordApp(root: string, computer: Pick<HudHostInfo, "computerSocket" | "computerOff" | "computerFailed"> = {}): void {
  try { writeHudHostMarker(root, { name: app.getName(), version: app.getVersion(), pid: process.pid, ...computer }); }
  catch (err) { console.warn(`[main] could not record the app in ${root}: ${err instanceof Error ? err.message : String(err)}`); }
}

/** Starts, keeps or stops the bridge to match the vault, the peer addon and the computer surface; called wherever the
 *  vault or the write policy changes. */
function syncBridge(): void {
  void bridges.sync(computerSys && computerPeer && computerOn() && vault.root ? vault.root : null);
}

async function makeBridge(root: string): Promise<{ stop(): Promise<void> }> {
  const sys = computerSys, peer = computerPeer;
  if (!sys || !peer) throw new Error("the peer addon did not load");
  // The data folder's own socket, or a short one in the user's temp folder when that path is too long (agent-computer D18).
  const socketPath = bridgeSocketPath(app.getPath("userData"), app.getPath("temp"));
  if (!socketPath) throw new Error("no socket path is short enough for this data folder");
  const next = new ComputerBridge({
    socketPath,
    peer,
    admit: (pid) => {
      let server: string;
      try { server = fs.realpathSync(path.join(root, "brain/scripts/sdk/mcp-server.js")); }
      catch { return { ok: false, reason: "The agenticos MCP server is not in this vault." }; }
      return admit(pid, { reg: agentRegistry, sys, server, trusted: e2e.trustedCli });
    },
    handle: (agent, call) => computerService.call(agent, call),
    onClose: (agent) => computerService.agentGone(agent),
    // M12: an agent the registry no longer holds (its CLI exited, its terminal closed) gets no more calls, and its
    // connection closes the moment it leaves.
    live: (agent) => agentRegistry.get(agent.pid)?.key === agent.key,
  });
  await next.start();
  // session-browser S23: the door starts where the bridge does; a session started while it is down gets no opener variables.
  await computerDoor?.start();
  const off = agentRegistry.onRemove((agent) => next.drop(agent.pid));
  recordApp(root, { computerSocket: socketPath });
  return { stop: async () => { off(); computerDoor?.stop(); await next.stop(); } };
}

/**
 * Attaches a vault: the services the page's calls go through, the app's record in the vault, the menubar item and the
 * watcher. At launch for an existing install; after the wizard's install, then the page reloads into the Workbench.
 */
function attachVault(root: string, source: string): void {
  vault = { root, source, configured: root };
  context.vaultRoot = root;
  context.agenticos = agenticos;
  policy = new WritePolicy(root, writes.surfaces);
  scope = new ReadScope(context);
  fsService = new FsService({ vaultRoot: root, userData: context.userData, scope: () => scope, policy: () => policy });
  attached = attachInfo(context.userData, root, agenticos, payload?.version ?? null);
  // D11: tell the runtime which app this vault is used with (doctor's `workbench app` row, the update check). A
  // vault the app cannot write to still opens: the record is informational.
  recordApp(root, { computerOff: !computerOn(), computerFailed: computerOn() && !(computerSys && computerPeer) });
  syncBridge();
  tray?.destroy();
  tray = new StatusTray(root, {
    openTab: (tab) => runCommand(tab === "pulse" ? "agentic-os:open-workbench" : `agentic-os:open-workbench-${tab}`),
    openFile: (rel) => openLink(`${SCHEME}://note?file=${encodeURIComponent(rel)}`),
    command: runCommand,
    show,
    togglePopover,
  });
  watcher?.stop();
  watcher = new VaultWatcher(root, (paths) => {
    send(CH.vaultChanges, { paths });
    if (paths.includes(STATUSLINE_PATH)) tray?.refresh();
  });
  watcher.start();
}

const setup = new SetupController({
  home: os.homedir(),
  userData: context.userData,
  env: process.env,
  payload,
  emit: (ev) => send(CH.setupEvent, ev),
  pty: () => require("node-pty") as PtyLib,
  attached: () => vault.root,
  attachInfo: () => attached,
  readAgenticos,
  attach: () => {
    agenticos = readAgenticos();
    const next = resolveVault();
    if (!next.root) return false;
    attachVault(next.root, next.source);
    // The page boots again, into the Workbench; links wait for its ready.
    rendererReady = false;
    setTimeout(() => win?.webContents.reload(), 0);
    return true;
  },
  refreshAttach: () => {
    agenticos = readAgenticos();
    context.agenticos = agenticos;
    if (vault.root) attached = attachInfo(context.userData, vault.root, agenticos, payload?.version ?? null);
  },
  chooseFolder: async () => {
    const opts: Electron.OpenDialogOptions = { title: "Choose the folder for your vault", buttonLabel: "Use This Folder", defaultPath: os.homedir(), properties: ["openDirectory", "createDirectory"] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
  // The toolchain's downloads (install-import B1) go through Chromium's network stack: the system's proxy settings and
  // certificate store, redirects followed (GitHub's release links), nothing cached.
  fetch: async (url, init) => {
    const r = await net.fetch(url, { signal: init.signal, cache: "no-store", redirect: "follow" });
    return { ok: r.ok, status: r.status, body: r.body as unknown as AsyncIterable<Uint8Array> | null };
  },
  // Only a development run reads another toolchain manifest (the e2e suite's stand-ins); a packaged app keeps its pins.
  allowManifestOverride: !app.isPackaged,
  macOS: process.getSystemVersion(),
});

registerHostIpc(trust, {
  boot: () => bootInfo(),
  ready: (info: ReadyInfo) => {
    rendererReady = true;
    commands = info.commands;
    setMenu();
    for (const req of pendingLinks.splice(0)) send(CH.protocol, req);
  },
  fs: () => fsService,
});
registerFsIpc(trust, () => fsService);
registerProcIpc(trust, procService, ptyService);
registerSessionIpc(trust, sessionService, gitService);
registerCodeIpc(trust, codeMirror, codeGit, codeImages);
registerShellIpc(trust, () => (vault.root ? scope : null), () => vault.root);
registerSetupIpc(trust, setup);
registerProposalsIpc(trust, () => vault.root, () => path.join(app.getPath("userData"), "proposal-undo"), () => policy.ids.includes("proposals"));
registerUpdateIpc(trust, {
  state: () => updates.state,
  check: () => updates.check(),
  install: () => { installRequests += 1; updates.install(); },
});
registerComputerIpc(trust, { enabled: computerOn, service: () => computerService, sessions: { terminal: (id) => ptyService.holdsOrigin(id), thread: (id) => sessionService.has(id) } });
registerThemeIpc(trust, { state: () => themeState(), set: (source) => setTheme(source) });

/** The page went (closed, crashed, reloaded, or quitting): its terminals go with it, and the children it was waiting on.
 *  A setup job (a fix-it's terminal, `aos init`, `aos upgrade`, the import and its scan) is the page's too. */
function endPageWork(): void {
  ptyService.killAll();
  procService.killAttached();
  setup.cancel();
  // agent-computer D7, D27: the page's asks go with it (each agent hears it was cancelled), the pop-out closes, and no
  // computer is on screen until the page selects one again. Quitting, the computer is already shut down (before-quit):
  // placing a view now could make a park window, and a window made while quitting keeps will-quit from firing.
  askBroker.cancel(() => true, "the app's window closed or reloaded");
  if (quitting) return;
  closeComputerPop();
  // session-browser S1: the next page counts its terminals from the start, so the Code sessions' browsers go too.
  computerService.pageGone();
  // The next page's Code keys start again at t1: an id issued before must not reach the terminal that reuses its key (a
  // detached program keeps its environment), and this runs before the new page can start a terminal.
  computerDoor?.revokeAll("code:");
  computerService.show(null);
  computerService.select(null);
}

function createWindow(): void {
  const state = loadWindowState(app.getPath("userData"));
  rendererReady = false;
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    title: BRAND.name,
    show: false,
    webPreferences: {
      // Phase 4 (D7): no Node in the page, an isolated preload, Chromium's sandbox. The page reaches the disk, processes
      // and the OS only through window.aos (src/preload), whose every call main checks (./ipc).
      preload: path.join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      // The tray popover's SidebarHUD runs in this renderer (renderer/popover.ts): keep it drawing while hidden.
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();
  trackWindowState(win, app.getPath("userData"));
  // One child window is allowed: the tray popover, opened blank by the renderer, which fills it itself. Anything else
  // a page tries to open goes to the OS (https only) or nowhere.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === POPOVER && url === "about:blank") {
      return { action: "allow", overrideBrowserWindowOptions: { ...POPOVER_OPTIONS, backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors) } };
    }
    openExternalSafe(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child, { frameName }) => {
    if (frameName !== POPOVER) { child.destroy(); return; }
    popover = child;
    child.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: "deny" }; });
    child.webContents.on("will-navigate", (e, url) => { e.preventDefault(); openExternalSafe(url); });
    child.on("blur", () => { if (!child.webContents.isDevToolsOpened()) child.hide(); });
    child.on("close", (e) => { if (!quitting) { e.preventDefault(); child.hide(); } });
    child.on("closed", () => { if (popover === child) popover = null; });
  });
  win.webContents.on("will-navigate", (e, url) => { e.preventDefault(); openExternalSafe(url); });
  // Deny every permission except writing to the clipboard (the HUD's ⧉ copy buttons), which Obsidian allows too.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
  win.webContents.on("render-process-gone", (_e, d) => { console.error(`[main] renderer gone: ${d.reason}`); endPageWork(); });
  // Closing the window hides it, as closing Obsidian's window would not stop a HUD you left running; ⌘Q quits.
  win.on("close", (e) => { if (!quitting && process.platform === "darwin") { e.preventDefault(); win?.hide(); } });
  win.on("closed", () => { win = null; rendererReady = false; endPageWork(); });
  // agent-computer D27: an ask the person could see becomes off-screen when the window loses focus, hides or minimizes.
  win.on("blur", recheckAsks);
  win.on("hide", recheckAsks);
  win.on("minimize", recheckAsks);
  win.once("ready-to-show", () => win?.show());
  void win.loadURL(`${APP_ORIGIN}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Registered before `ready`: macOS delivers a link that launched the app through this event.
  app.on("open-url", (e, url) => { e.preventDefault(); openLink(url); });
  app.on("second-instance", (_e, argv) => { const url = urlFromArgv(argv); if (url) openLink(url); else show(); });
  app.on("activate", () => show());
  // R86: with a terminal running, the quit waits for every terminal's exit, then is asked again (quit-gate.ts).
  app.on("before-quit", (e) => { quitting = true; shutdownComputer(); codeMirror.stopAll(); gate.hold(e); });
  // Any quitAndInstall, not only Restart to Update's: Squirrel's own signal comes before the windows are asked to close.
  // The terminals end now; `before-quit`, which follows the windows' closing, waits for what is left of them.
  autoUpdater.on("before-quit-for-update", () => { quitting = true; shutdownComputer(); codeMirror.stopAll(); ptyService.killAll(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  // The marker keeps no Computer state past the app: an agent asking now hears that the app is not running.
  // The daily image prune started once the app is ready (code-chat M2); stopped at quit like the other services.
  let stopImagePrune: () => void = () => {};
  app.on("will-quit", () => { if (vault.root) recordApp(vault.root); void bridges.sync(null); watcher?.stop(); tray?.destroy(); updates.stop(); endPageWork(); sessionService.killAll(); codeMirror.stopAll(); shutdownComputer(); stopImagePrune(); });

  void app.whenReady().then(() => {
    restoreComputer();
    // agent-computer D39: downloads a crash or a kill left waiting in the temp folder go (a running app's stay).
    sweepHeld(app.getPath("temp"));
    // code-chat R59: the Code composer's images go about three months after their month ended, checked now and once a day
    // while the app stays open (M2). Asynchronous, so nothing here waits for it; the surface being off does not keep old
    // images.
    stopImagePrune = codeImages.keepPruned((n) => { if (n) console.log(`[main] code-images: removed ${n} old image(s)`); }, (err) => console.warn("[main] code-images: retention failed", err));
    // Only a packaged, signed app claims the scheme; a dev run must not re-point the system's agenticos:// handler.
    if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME);
    serveAppScheme(path.join(__dirname, "../renderer"));
    // macOS switched appearance (while the choice is "system"), or high contrast changed.
    nativeTheme.on("updated", broadcastTheme);
    setMenu();
    createWindow();
    if (vault.root) attachVault(vault.root, vault.source);
    updates.start();
    const cold = urlFromArgv(process.argv);
    if (cold) openLink(cold);
  });
}

// For tests and the screenshot spec (reached through Playwright's electronApp.evaluate, never from the renderer).
(globalThis as Record<string, unknown>).__aosMain = {
  openLink, runCommand, tray: () => tray?.state() ?? null,
  togglePopover: () => togglePopover({ x: 0, y: 0, width: 0, height: 0 }),
  popoverVisible: () => !!popover && !popover.isDestroyed() && popover.isVisible(),
  // The updater's state as a spec sets it (a dev run never downloads one), and the Restart to Update requests.
  setUpdateState: (s: Parameters<UpdateService["set"]>[0]) => updates.set(s),
  installRequests: () => installRequests,
  vaultRoot: () => vault.root,
  // Light and dark as the theme spec drives them (it cannot switch macOS's own appearance).
  theme: () => themeState(),
  setTheme: (source: ThemeSource) => setTheme(source),
  // The computer's ask notices raised off-screen (agent-computer D27), as the notifier passed them to the desktop.
  computerNotices: () => computerNotices.map((n) => ({ ...n })),
  // The addresses main opened in the default browser (opened) or refused (not), newest last (dev runs and test builds only).
  externalOpens: () => externalOpens(),
  // The webContents id of the active tab of a session's browser (the selected session's by default), for the e2e specs' own look at a page.
  computerPageId: (session?: string) => computerService.activeWebContentsId(session),
  // The session the pane has selected, so a spec can turn its browser on (a browser starts off, session-browser S2).
  computerSelected: () => computerService.selectedSession(),
};
