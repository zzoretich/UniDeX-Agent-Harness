// The preload: the page's only way into main (phase 4, S9). It runs sandboxed, with context isolation, and exposes
// window.aos: named functions over the channels of ../shared/ipc.ts, never ipcRenderer itself, a generic invoke, or
// an event object. Main checks every call's sender and arguments; this file only carries them.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH, type AosBridge, type BootInfo, type ProcEvent, type ProtocolRequest, type PtyEvent, type Result, type SessionEvent, type SetupEvent, type ThemeState, type UpdateState } from "../shared/ipc";

/** What the page sees when main does not answer an update query: updates off. */
const OFF: UpdateState = { status: "off", reason: "no answer from the app", version: null, percent: null, error: null };

/** What the page draws in when main does not answer a theme query: macOS's appearance as the page sees it. */
const systemTheme = (): ThemeState => ({ source: "system", dark: window.matchMedia("(prefers-color-scheme: dark)").matches });

const sync = <T>(channel: string, args: unknown): Result<T> => ipcRenderer.sendSync(channel, args) as Result<T>;
const invoke = <T>(channel: string, args: unknown): Promise<Result<T>> => ipcRenderer.invoke(channel, args) as Promise<Result<T>>;

/** Subscribes `cb` to a main → page event; returns the unsubscribe function. The event object stays here. */
function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const api: AosBridge = {
  boot: () => { const r = sync<BootInfo>(CH.boot, {}); return r.ok ? r.data : null; },
  ready: (info) => ipcRenderer.send(CH.ready, info),
  onCommand: (cb) => listen<unknown>(CH.command, (id) => { if (typeof id === "string") cb(id); }),
  onProtocol: (cb) => listen<ProtocolRequest | null>(CH.protocol, (req) => { if (req && typeof req.action === "string") cb(req); }),
  onVaultChanges: (cb) => listen<{ paths?: unknown } | null>(CH.vaultChanges, (c) => { if (Array.isArray(c?.paths)) cb(c.paths.map(String)); }),
  fs: {
    exists: (p) => sync(CH.fsExists, { p }),
    stat: (p) => sync(CH.fsStat, { p }),
    readText: (p) => sync(CH.fsReadText, { p }),
    readBytes: (p, position, length) => sync(CH.fsReadBytes, { p, position, length }),
    readdir: (p) => sync(CH.fsReaddir, { p }),
    walk: () => sync(CH.fsWalk, {}),
    writeText: (p, data, via) => sync(CH.fsWriteText, { p, data, via }),
    appendText: (p, data) => sync(CH.fsAppendText, { p, data }),
    mkdir: (p, recursive) => sync(CH.fsMkdir, { p, recursive }),
    remove: (p, recursive) => sync(CH.fsRemove, { p, recursive }),
    rename: (from, to) => sync(CH.fsRename, { from, to }),
    copy: (from, to) => sync(CH.fsCopy, { from, to }),
    trash: (p) => invoke(CH.fsTrash, { p }),
  },
  proc: {
    spawn: (req) => sync(CH.procSpawn, req),
    kill: (id, signal) => ipcRenderer.send(CH.procKill, { id, signal }),
    execSync: (req) => sync(CH.procExecSync, req),
    onEvent: (cb) => listen<ProcEvent>(CH.procEvent, cb),
  },
  pty: {
    available: () => sync(CH.ptyAvailable, {}),
    spawn: (req) => sync(CH.ptySpawn, req),
    write: (id, data) => ipcRenderer.send(CH.ptyWrite, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(CH.ptyResize, { id, cols, rows }),
    kill: (id, signal) => ipcRenderer.send(CH.ptyKill, { id, signal }),
    onEvent: (cb) => listen<PtyEvent>(CH.ptyEvent, cb),
  },
  shell: {
    openExternal: (url) => ipcRenderer.send(CH.shellOpenExternal, { url }),
    openPath: async (p) => { const r = await invoke<string>(CH.shellOpenPath, { p }); return r.ok ? r.data : r.error; },
    showItemInFolder: (p) => ipcRenderer.send(CH.shellShowItem, { p }),
  },
  plugin: {
    loadData: (id) => sync(CH.pluginLoadData, { id }),
    saveData: (id, json) => sync(CH.pluginSaveData, { id, json }),
  },
  setup: {
    preflight: () => invoke(CH.setupPreflight, {}),
    fix: (id, cols, rows) => sync(CH.setupFix, { id, cols, rows }),
    input: (data) => ipcRenderer.send(CH.setupInput, { data }),
    resize: (cols, rows) => ipcRenderer.send(CH.setupResize, { cols, rows }),
    cancel: () => ipcRenderer.send(CH.setupCancel, {}),
    chooseVault: async () => { const r = await invoke<string | null>(CH.setupChooseVault, {}); return r.ok ? r.data : null; },
    install: (req) => sync(CH.setupInstall, req),
    claudeMd: () => sync(CH.setupClaudeMd, {}),
    applyClaudeMd: () => sync(CH.setupApplyClaudeMd, {}),
    finish: () => sync(CH.setupFinish, {}),
    upgrade: () => sync(CH.setupUpgrade, {}),
    noted: () => ipcRenderer.send(CH.setupNoted, {}),
    pathLine: () => sync(CH.setupPathLine, {}),
    addToPath: () => sync(CH.setupAddToPath, {}),
    importScan: () => invoke(CH.setupImportScan, {}),
    importHistory: (req) => sync(CH.setupImport, req),
    unwire: (host, choice) => sync(CH.setupUnwire, { host, choice }),
    onEvent: (cb) => listen<SetupEvent>(CH.setupEvent, cb),
  },
  update: {
    state: () => { const r = sync<UpdateState>(CH.updateState, {}); return r.ok ? r.data : OFF; },
    check: () => ipcRenderer.send(CH.updateCheck, {}),
    install: () => ipcRenderer.send(CH.updateInstall, {}),
    onState: (cb) => listen<UpdateState>(CH.updateEvent, cb),
  },
  theme: {
    state: () => { const r = sync<ThemeState>(CH.themeState, {}); return r.ok ? r.data : systemTheme(); },
    set: (source) => sync(CH.themeSet, { source }),
    onChange: (cb) => listen<ThemeState>(CH.themeEvent, cb),
  },
  sessions: {
    start: (req) => invoke(CH.sessionStart, req),
    send: (req) => invoke(CH.sessionSend, req),
    stop: (thread) => ipcRenderer.send(CH.sessionStop, { thread }),
    list: () => invoke(CH.sessionList, {}),
    read: (thread) => invoke(CH.sessionRead, { thread }),
    catalog: (refresh) => invoke(CH.sessionCatalog, refresh ? { refresh: true } : {}),
    onEvent: (cb) => listen<SessionEvent>(CH.sessionEvent, cb),
  },
  git: {
    status: (workspace) => invoke(CH.gitStatus, { workspace }),
    diff: (workspace, file) => invoke(CH.gitDiff, file === undefined ? { workspace } : { workspace, file }),
    commit: (workspace, message) => invoke(CH.gitCommit, { workspace, message }),
  },
};

contextBridge.exposeInMainWorld("aos", api);
