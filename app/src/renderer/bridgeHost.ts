// The HUD's host in the app (phase 4, S1): HudHost (../hud/src/host.ts) over the preload's bridge. The page
// has no Node; every file, process, terminal and OS call here is a call to main, which checks it. What main refuses is
// recorded in the guard log and answered as Node would answer a refusal: an EROFS error, or for a spawn a child that
// prints why and exits 1 (as the page's write guards did before main took the checks over).

import type { HostChild, HostDirent, HostFs, HostGit, HostPty, HostPtyProcess, HostSessions, HostStats, HudHost } from "../../../hud/src/host";
import { refuse } from "../../obsidian-compat/src/guard";
import { callError } from "../../obsidian-compat/src/bridge";
import * as path from "./shims/path";
import type { AosBridge, BootInfo, DirEntryInfo, ProcEvent, PtyEvent, Result, StatInfo } from "../shared/ipc";

type Failure = Extract<Result<unknown>, { ok: false }>;

/** One line for the guard log. Long arguments keep their tail, where a script path's name is. */
export function describe(cmd: string, args: readonly string[] = []): string {
  return [cmd, ...args].map((s) => { s = String(s); return s.length > 90 ? `…${s.slice(-87)}` : s; }).join(" ").slice(0, 400);
}

function stats(s: StatInfo): HostStats {
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, isFile: () => s.file, isDirectory: () => s.dir, isSymbolicLink: () => s.link };
}

function dirent(d: DirEntryInfo): HostDirent {
  return { name: d.name, isFile: () => d.file, isDirectory: () => d.dir, isSymbolicLink: () => d.link };
}

/** A tiny event emitter: the part of Node's the HUD's child and stream listeners use. */
class Emitter {
  private readonly listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  on(event: string, fn: (...a: never[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn as (...a: unknown[]) => void);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try { fn(...args); } catch (err) { console.error(`[host] ${event} listener`, err); }
    }
  }
  count(event: string): number { return this.listeners.get(event)?.length ?? 0; }
}

/** A child process main runs for the page: output as text, then exit and close. */
class BridgeChild extends Emitter implements HostChild {
  readonly stdout: Emitter | null;
  readonly stderr: Emitter | null;
  pid?: number;
  private done = false;

  constructor(private readonly kill_: (signal?: string) => void, piped: boolean) {
    super();
    this.stdout = piped ? new Emitter() : null;
    this.stderr = piped ? new Emitter() : null;
  }

  kill(signal?: string): boolean { if (this.done) return false; this.kill_(signal); return true; }
  unref(): void { /* main holds the process; the page never waits on it to exit */ }

  /** An event from main for this child. */
  feed(ev: ProcEvent): void {
    if (ev.type === "stdout") this.stdout?.emit("data", ev.data);
    else if (ev.type === "stderr") this.stderr?.emit("data", ev.data);
    else if (ev.type === "error") { const err = new Error(ev.message) as NodeJS.ErrnoException; err.code = ev.message; this.emit("error", err); }
    else if (ev.type === "exit") this.finish(ev.code, ev.signal);
  }

  finish(code: number | null, signal: string | null): void {
    if (this.done) return;
    this.done = true;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  /** A child that never started: it reports why on stderr and as an error (when someone listens), and exits 1. */
  failLater(err: Error): void {
    setTimeout(() => {
      this.stderr?.emit("data", err.message);
      if (this.count("error") > 0) this.emit("error", err);
      this.finish(1, null);
    }, 0);
  }
}

export interface BridgeHost {
  host: HudHost;
  /** Subscribes to main's vault watcher (vault-relative paths); one bridge subscription serves every subscriber. */
  onVaultChanges(cb: (paths: string[]) => void): () => void;
}

export function createBridgeHost(aos: AosBridge, info: BootInfo): BridgeHost {
  const vaultRoot = info.vaultRoot;

  // ── vault changes: one subscription, fanned out ──
  const changeListeners = new Set<(paths: string[]) => void>();
  let changeSub: (() => void) | null = null;
  const onVaultChanges = (cb: (paths: string[]) => void): (() => void) => {
    changeListeners.add(cb);
    changeSub ??= aos.onVaultChanges((paths) => { for (const l of [...changeListeners]) l(paths); });
    return () => { changeListeners.delete(cb); };
  };

  // ── files ──
  const readFailure = (r: Failure, what: string): Error => (r.code === "EROFS" ? refuse("read", what) : callError(r, what));
  const writeFailure = (r: Failure, what: string): Error => (r.code === "EROFS" ? refuse("write", what) : callError(r, what));
  const unwrapRead = <T>(r: Result<T>, what: string): T => { if (!r.ok) throw readFailure(r, what); return r.data; };
  const unwrapWrite = (r: Result<null>, what: string): void => { if (!r.ok) throw writeFailure(r, what); };
  const later = <T>(fn: () => T): Promise<T> => new Promise((resolve, reject) => { try { resolve(fn()); } catch (err) { reject(err); } });

  const fs: HostFs = {
    existsSync: (p) => {
      const r = aos.fs.exists(p);
      if (r.ok) return r.data;
      if (r.code === "EROFS") refuse("read", `exists ${p}`);
      return false;
    },
    statSync: (p) => stats(unwrapRead(aos.fs.stat(p), `stat ${p}`)),
    readFileSync: (p) => unwrapRead(aos.fs.readText(p), `read ${p}`),
    readdirSync: ((p: string, opts?: { withFileTypes: true }) => {
      const list = unwrapRead(aos.fs.readdir(p), `list ${p}`);
      return opts?.withFileTypes ? list.map(dirent) : list.map((d) => d.name);
    }) as HostFs["readdirSync"],
    readBytesSync: (p, position, length) => unwrapRead(aos.fs.readBytes(p, position, length), `read ${p}`),
    writeFileSync: (p, data) => unwrapWrite(aos.fs.writeText(p, data, "hud"), `fs.writeFile ${p}`),
    appendFileSync: (p, data) => unwrapWrite(aos.fs.appendText(p, data), `fs.appendFile ${p}`),
    mkdirSync: (p, opts) => unwrapWrite(aos.fs.mkdir(p, !!opts?.recursive), `fs.mkdir ${p}`),
    watch: (p, listener) => {
      const rel = vaultRoot ? path.relative(path.resolve(vaultRoot), path.resolve(p)) : "";
      if (!vaultRoot || !rel || rel.startsWith("..")) throw refuse("read", `watch ${p}`);
      const off = onVaultChanges((paths) => { if (paths.includes(rel)) listener(); });
      return { close: off };
    },
    promises: {
      readFile: (p) => later(() => fs.readFileSync(p, "utf8")),
      readdir: (p, opts) => later(() => fs.readdirSync(p, opts)),
      stat: (p) => later(() => fs.statSync(p)),
      access: (p) => later(() => { if (!fs.existsSync(p)) { const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } }),
    },
  };

  // ── processes ──
  const children = new Map<string, BridgeChild>();
  let procSub: (() => void) | null = null;
  let seq = 0;
  const spawn: HudHost["spawn"] = (cmd, args, opts = {}) => {
    procSub ??= aos.proc.onEvent((ev) => {
      const c = children.get(ev.id);
      if (!c) return;
      c.feed(ev);
      if (ev.type === "exit") children.delete(ev.id);
    });
    const id = `p${++seq}`;
    const piped = opts.stdio !== "ignore";
    const child = new BridgeChild((signal) => aos.proc.kill(id, signal), piped);
    children.set(id, child);
    const r = aos.proc.spawn({ id, cmd, args, cwd: opts.cwd, env: opts.env, unsetEnv: opts.unsetEnv, stdio: opts.stdio, detached: opts.detached });
    if (r.ok) { child.pid = r.data.pid ?? undefined; return child; }
    children.delete(id);
    child.failLater(r.code === "EROFS" ? refuse("spawn", describe(cmd, args)) : callError(r, describe(cmd, args)));
    return child;
  };

  // ── terminals ──
  const terminals = new Map<string, { data: Array<(d: string) => void>; exit: Array<(e: { exitCode: number; signal?: number }) => void> }>();
  let ptySub: (() => void) | null = null;
  const pty: HostPty = {
    loadError: () => { const r = aos.pty.available(); return r.ok ? null : r.error; },
    spawn: (file, args, opts): HostPtyProcess => {
      ptySub ??= aos.pty.onEvent((ev: PtyEvent) => {
        const t = terminals.get(ev.id);
        if (!t) return;
        if (ev.type === "data") for (const l of t.data) l(ev.data);
        else { terminals.delete(ev.id); for (const l of t.exit) l({ exitCode: ev.exitCode, signal: ev.signal }); }
      });
      const id = `t${++seq}`;
      const t = { data: [] as Array<(d: string) => void>, exit: [] as Array<(e: { exitCode: number; signal?: number }) => void> };
      terminals.set(id, t);
      const r = aos.pty.spawn({ id, file, args, cwd: opts.cwd, name: opts.name, cols: opts.cols, rows: opts.rows, env: opts.env });
      if (!r.ok) {
        terminals.delete(id);
        throw r.code === "EROFS" ? refuse("spawn", describe(file, args)) : callError(r, `terminal ${file}`);
      }
      return {
        pid: r.data.pid,
        write: (data) => aos.pty.write(id, data),
        resize: (cols, rows) => aos.pty.resize(id, cols, rows),
        kill: (signal) => aos.pty.kill(id, signal),
        onData: (cb) => { t.data.push(cb); },
        onExit: (cb) => { t.exit.push(cb); },
      };
    },
  };

  // ── agent sessions and their repositories: main answers every call with a Result, refusals included; a call that
  // fails on the way (the bridge itself) answers the same way, so the HUD shows it rather than throws ──
  const settle = <T>(p: Promise<Result<T>>): Promise<Result<T>> =>
    p.catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err), code: "EIO" }));
  const sessions: HostSessions = {
    start: (req) => settle(aos.sessions.start(req)),
    send: (req) => settle(aos.sessions.send(req)),
    stop: (thread) => aos.sessions.stop(thread),
    list: () => settle(aos.sessions.list()),
    read: (thread) => settle(aos.sessions.read(thread)),
    catalog: (refresh) => settle(aos.sessions.catalog(refresh)),
    onEvent: (cb) => aos.sessions.onEvent(cb),
  };
  const git: HostGit = {
    status: (workspace) => settle(aos.git.status(workspace)),
    diff: (workspace, file) => settle(aos.git.diff(workspace, file)),
    commit: (workspace, message) => settle(aos.git.commit(workspace, message)),
  };

  const host: HudHost = {
    fs,
    spawn,
    sessions,
    git,
    execFileSync: (file, args, opts) => {
      const r = aos.proc.execSync({ file, args, timeoutMs: opts.timeout });
      if (!r.ok) throw r.code === "EROFS" ? refuse("spawn", describe(file, args)) : callError(r, describe(file, args));
      return r.data;
    },
    pty,
    shell: {
      openPath: (p) => aos.shell.openPath(p),
      openExternal: async (url) => { aos.shell.openExternal(url); },
      showItemInFolder: (p) => aos.shell.showItemInFolder(p),
    },
    env: {
      get: (name) => info.env[name],
      homedir: () => info.home,
      platform: () => info.platform,
      cwd: () => vaultRoot ?? info.home,
    },
  };
  return { host, onVaultChanges };
}
