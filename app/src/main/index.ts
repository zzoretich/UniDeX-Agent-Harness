// Main process: the Workbench window, the menubar item, the app menu, agenticos:// links and the vault watcher. The app
// attaches to the vault an existing AgenticOS install uses (agenticos.json); with none, the page shows the first-run
// wizard, which runs `aos init` from the runtime the app carries (./setup, phase 5) and then attaches the vault it made
// without a relaunch. The page runs sandboxed with no Node (phase 4): every file it reads or writes, every process and
// terminal it starts and everything it hands to the OS goes through the preload's bridge to the handlers in ./ipc, which
// check it against the read scope, the write surfaces and the program rules (./policy). Main itself writes one file
// outside its userData: the app's record in the vault's runtime cache (hud-host.ts). The app updates itself (./updater).

import { app, autoUpdater, BrowserWindow, dialog, Menu, nativeTheme, net, screen, type Rectangle } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_ORIGIN, CH, POPOVER, type AttachInfo, type BootInfo, type CommandInfo, type ProtocolRequest, type ReadyInfo, type ThemeSource, type ThemeState } from "../shared/ipc";
import { registerAppScheme, serveAppScheme } from "./app-scheme";
import { BRAND } from "../shared/brand";
import { writeHudHostMarker } from "./hud-host";
import { registerFsIpc } from "./ipc/fs";
import { registerHostIpc } from "./ipc/host";
import { registerProcIpc } from "./ipc/proc";
import { registerSessionIpc } from "./ipc/sessions";
import { registerSetupIpc, registerUpdateIpc } from "./ipc/setup";
import { openExternalSafe, registerShellIpc } from "./ipc/shell";
import { registerThemeIpc } from "./ipc/theme";
import { trustMainWindow } from "./ipc/trust";
import { buildAppMenu } from "./menu";
import { debugSwitches } from "./policy/debug";
import { parseShells, type ProgramContext } from "./policy/programs";
import { ReadScope, type AgenticosPaths } from "./policy/read-scope";
import { WritePolicy } from "./policy/write-policy";
import { SCHEME, parseAgenticosUrl, urlFromArgv } from "./protocol";
import { FsService } from "./services/fs";
import { ProcService } from "./services/proc";
import { GitService } from "./services/git";
import { PtyService, terminalBaseEnv, type PtyLib } from "./services/pty";
import { SessionService, workspaceDir } from "./services/sessions";
import { attachInfo } from "./setup/attach";
import { SetupController, type AgenticosJson } from "./setup/controller";
import { defaultLoginPathDeps, findOnPath, isExecutable, loginPath } from "./setup/env";
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
// The app's own node-pty: in a packaged build its JavaScript is in the archive and its native parts are unpacked beside it.
// Its terminals start with the login shell's PATH (T14), worked out once and shared with sessionNode.
const ptyService = new PtyService({ context: () => context, env: () => terminalBaseEnv(process.env, termPATH()), emit: (ev) => send(CH.ptyEvent, ev), load: () => require("node-pty") as PtyLib });
// Agent sessions (UniDeX phase 2) and the workspace repositories they change: main's own services, behind the Sessions
// surface. A turn outlives a page reload; quitting stops every one.
const sessionsOn = (): boolean => policy.ids.includes("sessions");
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
const sessionService = new SessionService({ vaultRoot: () => context.vaultRoot ?? null, enabled: sessionsOn, context: () => context, env: process.env, node: sessionNode, emit: (ev) => send(CH.sessionEvent, ev) });
const gitService = new GitService({ workspace: (name) => workspaceDir(context.vaultRoot ?? null, name), enabled: sessionsOn, env: process.env });

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
  };
}

let win: BrowserWindow | null = null;
let tray: StatusTray | null = null;
let watcher: VaultWatcher | null = null;
let quitting = false;
/** Set when the quit is an update's: an updater error before the app exits gives the window its hide-on-close back. */
let quittingForUpdate = false;
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
    if (s.status === "error" && quittingForUpdate) { quittingForUpdate = false; quitting = false; }
    send(CH.updateEvent, s);
    setMenu();
  },
  // The window hides on close until the app quits; an update's quit closes the windows before `before-quit`, so it says so first.
  beforeInstall: () => { quitting = true; quittingForUpdate = true; },
});
/** How many times the page asked to restart into an update (the e2e suite reads it: a dev run has no update to install). */
let installRequests = 0;

/** Only our own page, in our own window's main frame, may talk to main. */
const trust = trustMainWindow(() => win);

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

function show(): void {
  if (!win) createWindow();
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
  for (const w of [win, popover]) if (w && !w.isDestroyed()) w.setBackgroundColor(windowBackground(s.dark));
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
  try { writeHudHostMarker(root, { name: app.getName(), version: app.getVersion() }); }
  catch (err) { console.warn(`[main] could not record the app in ${root}: ${err instanceof Error ? err.message : String(err)}`); }
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
registerShellIpc(trust, () => (vault.root ? scope : null), () => vault.root);
registerSetupIpc(trust, setup);
registerUpdateIpc(trust, {
  state: () => updates.state,
  check: () => updates.check(),
  install: () => { installRequests += 1; updates.install(); },
});
registerThemeIpc(trust, { state: () => themeState(), set: (source) => setTheme(source) });

/** The page went (closed, crashed, reloaded, or quitting): its terminals go with it, and the children it was waiting on.
 *  A setup job (a fix-it's terminal, `aos init`, `aos upgrade`, the import and its scan) is the page's too. */
function endPageWork(): void {
  ptyService.killAll();
  procService.killAttached();
  setup.cancel();
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
  app.on("before-quit", () => { quitting = true; quittingForUpdate = false; });
  // Any quitAndInstall, not only Restart to Update's: Squirrel's own signal comes before the windows are asked to close.
  autoUpdater.on("before-quit-for-update", () => { quitting = true; quittingForUpdate = true; });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("will-quit", () => { watcher?.stop(); tray?.destroy(); updates.stop(); endPageWork(); sessionService.killAll(); });

  void app.whenReady().then(() => {
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
};
