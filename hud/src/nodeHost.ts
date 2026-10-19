// nodeHost.ts — the HudHost over plain Node (host.ts): the default under node:test. The only HUD file that imports
// Node's I/O modules or node-pty. The UniDeX app never loads it: its build answers this module with one
// that refuses, and installs its own host first.
import * as childProcess from "child_process";
import * as nodeFs from "fs";
import * as os from "os";
import type { HostChild, HostFs, HostPty, HostPtyProcess, HostSpawnOptions, HudHost } from "./host";

function readBytesSync(p: string, position: number, length: number): Uint8Array {
  const buf = Buffer.alloc(Math.max(0, length));
  const fd = nodeFs.openSync(p, "r");
  try {
    const n = nodeFs.readSync(fd, buf, 0, buf.length, position);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  } finally {
    nodeFs.closeSync(fd);
  }
}

const hostFs: HostFs = {
  existsSync: (p) => nodeFs.existsSync(p),
  statSync: (p) => nodeFs.statSync(p),
  readFileSync: (p, encoding) => nodeFs.readFileSync(p, encoding),
  readdirSync: ((p: string, opts?: { withFileTypes: true }) =>
    (opts ? nodeFs.readdirSync(p, opts) : nodeFs.readdirSync(p))) as HostFs["readdirSync"],
  readBytesSync,
  writeFileSync: (p, data) => nodeFs.writeFileSync(p, data),
  appendFileSync: (p, data) => nodeFs.appendFileSync(p, data),
  mkdirSync: (p, opts) => { nodeFs.mkdirSync(p, opts); },
  watch: (p, listener) => {
    const w = nodeFs.watch(p, { persistent: false }, () => listener());
    w.on("error", () => { /* the file went; the caller re-reads on its next event */ });
    return w;
  },
  promises: {
    readFile: (p, encoding) => nodeFs.promises.readFile(p, encoding),
    readdir: (p, opts) => nodeFs.promises.readdir(p, opts),
    stat: (p) => nodeFs.promises.stat(p),
    access: (p) => nodeFs.promises.access(p),
  },
};

/** The host's environment with `set` on top and `unset` removed. */
function childEnv(set: Record<string, string> = {}, unset: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, ...set };
  for (const k of unset) delete out[k];
  return out;
}

function spawn(command: string, args: string[], opts: HostSpawnOptions = {}): HostChild {
  const child = childProcess.spawn(command, args, {
    cwd: opts.cwd,
    env: childEnv(opts.env, opts.unsetEnv),
    // stdin is never written: /dev/null, so a CLI that reads it sees its end at once.
    stdio: opts.stdio === "ignore" ? "ignore" : ["ignore", "pipe", "pipe"],
    detached: opts.detached,
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return child as unknown as HostChild;
}

// ── node-pty, loaded on first use ───────────────────────────────────

type PtyLib = { spawn: (file: string, args: string[], options: Record<string, unknown>) => HostPtyProcess };

let ptyLib: PtyLib | null = null;
let ptyLoadError: string | null = null;

function loadPty(): PtyLib {
  if (ptyLib) return ptyLib;
  if (ptyLoadError) throw new Error(`node-pty failed to load: ${ptyLoadError}`);
  try {
    ptyLib = require("node-pty") as PtyLib;
    return ptyLib;
  } catch (e) {
    ptyLoadError = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new Error(`node-pty failed to load: ${ptyLoadError}`);
  }
}

const pty: HostPty = {
  spawn: (file, args, opts) => loadPty().spawn(file, args, { ...opts, env: childEnv(opts.env) }),
  loadError: () => { try { loadPty(); return null; } catch { return ptyLoadError; } },
};

export function createNodeHost(): HudHost {
  return {
    fs: hostFs,
    spawn,
    execFileSync: (file, args, opts) => childProcess.execFileSync(file, args, opts),
    pty,
    // Plain Node has no OS shell to hand a file or a link to.
    shell: {
      openPath: async () => "no OS shell outside the app",
      openExternal: async () => { /* nothing to open it with */ },
      showItemInFolder: () => { /* nothing to show it in */ },
    },
    env: {
      get: (name) => process.env[name],
      homedir: () => os.homedir(),
      platform: () => process.platform,
      cwd: () => process.cwd(),
    },
    // No `sessions` or `git`: only the app's main process runs agent sessions (the Sessions tab says so).
  };
}
