// Gives the unit tests' empty electron stand-in an `ipcMain` that records its handlers. Import it before any module
// that registers IPC handlers: the bundle copies the stand-in's properties when the first of them loads.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require("./electron-stub.cjs") as { ipcMain?: unknown };

export type IpcFn = (e: unknown, raw: unknown) => unknown;
export const on = new Map<string, IpcFn>();
export const handle = new Map<string, IpcFn>();
stub.ipcMain = { on: (c: string, f: IpcFn) => on.set(c, f), handle: (c: string, f: IpcFn) => handle.set(c, f) };
