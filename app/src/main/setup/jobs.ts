// The wizard's one running job (phase 5, I4, I5): a login in a terminal, a toolchain job main runs itself (a download
// and its install, install-import B1), or `aos init` / `aos upgrade` as a child process. A login gets a pty because it
// prints a code to type; the install and the upgrade get no stdin at all (`--yes`), so nothing in them can wait on a
// prompt the user cannot see. Output and a download's progress stream to the page as setup events; the page draws the
// output in one terminal view.

import * as childProcess from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Result, SetupEvent, SetupJob } from "../../shared/ipc";
import type { PtyLib, PtyProcess } from "../services/pty";
import type { TaskContext } from "./toolchain";

export interface JobRunnerOptions {
  emit: (ev: SetupEvent) => void;
  /** node-pty (the tests pass a fake). */
  pty: () => PtyLib;
  spawnImpl?: typeof childProcess.spawn;
  /** Called after a job's exit event, with its code (main refreshes state there). */
  onExit?: (job: SetupJob, code: number | null) => void;
}

interface Running { job: SetupJob; pty?: PtyProcess; child?: childProcess.ChildProcess; abort?: AbortController }

/** A progress event at most this often, besides the first and the last. */
const PROGRESS_MS = 150;

const term = (s: string): string => s.replace(/\r?\n/g, "\r\n");

const busy: Result<never> = { ok: false, error: "another setup step is running", code: "EBUSY" };

export class JobRunner {
  private current: Running | null = null;

  constructor(private readonly o: JobRunnerOptions) {}

  get running(): SetupJob | null { return this.current?.job ?? null; }

  private exited(job: SetupJob, code: number | null, signal: string | null): void {
    this.current = null;
    this.o.emit({ job, type: "exit", code, signal });
    this.o.onExit?.(job, code);
  }

  /** A command in a terminal: the user sees it typed, then its output, and can answer what it asks. */
  startPty(job: SetupJob, file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; echo: string }): Result<null> {
    if (this.current) return busy;
    let p: PtyProcess;
    try {
      p = this.o.pty().spawn(file, args, { name: "xterm-256color", cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
    } catch (err) { return { ok: false, error: `could not open a terminal: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, code: "ENOSYS" }; }
    this.current = { job, pty: p };
    this.o.emit({ job, type: "data", data: `\x1b[2m$ ${o.echo}\x1b[0m\r\n` });
    p.onData((data) => this.o.emit({ job, type: "data", data }));
    p.onExit((e) => this.exited(job, e.exitCode, e.signal ? String(e.signal) : null));
    return { ok: true, data: null };
  }

  /**
   * Work main does itself (a toolchain job): its lines and raw output go to the terminal, its progress as progress
   * events (throttled), and it ends with exit 0, or 1 after its error's message, or a signal when it was stopped.
   */
  startTask(job: SetupJob, task: (ctx: TaskContext) => Promise<void>, o: { echo: string }): Result<null> {
    if (this.current) return busy;
    const abort = new AbortController();
    this.current = { job, abort };
    this.o.emit({ job, type: "data", data: `\x1b[2m# ${o.echo}\x1b[0m\r\n` });
    let last = 0;
    const ctx: TaskContext = {
      signal: abort.signal,
      log: (line) => this.o.emit({ job, type: "data", data: `${term(line)}\r\n` }),
      write: (text) => { if (text) this.o.emit({ job, type: "data", data: term(text) }); },
      progress: (p) => {
        const now = Date.now();
        if (p.received !== 0 && p.received !== p.total && now - last < PROGRESS_MS) return;
        last = now;
        this.o.emit({ job, type: "progress", label: p.label, received: p.received, total: p.total });
      },
    };
    void Promise.resolve().then(() => task(ctx)).then(
      () => this.exited(job, 0, null),
      (err: unknown) => {
        if (abort.signal.aborted) { this.exited(job, null, "SIGTERM"); return; }
        this.o.emit({ job, type: "data", data: `\x1b[31m${term(err instanceof Error ? err.message : String(err))}\x1b[0m\r\n` });
        this.exited(job, 1, null);
      },
    );
    return { ok: true, data: null };
  }

  /** A command with no stdin, its stdout and stderr together, line ends made terminal-ready. */
  startProc(job: SetupJob, file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; echo: string }): Result<null> {
    if (this.current) return busy;
    let child: childProcess.ChildProcess;
    try {
      child = (this.o.spawnImpl ?? childProcess.spawn)(file, args, { cwd: o.cwd, env: o.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), code: "EIO" }; }
    this.current = { job, child };
    this.o.emit({ job, type: "data", data: `\x1b[2m$ ${o.echo}\x1b[0m\r\n` });
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (b: Buffer) => { const data = decoder.write(b); if (data) this.o.emit({ job, type: "data", data: term(data) }); });
      stream?.on("end", () => { const data = decoder.end(); if (data) this.o.emit({ job, type: "data", data: term(data) }); });
    }
    let done = false;
    child.on("error", (err) => {
      this.o.emit({ job, type: "data", data: `\r\n${(err as NodeJS.ErrnoException).code ?? err.message}\r\n` });
      if (!done) { done = true; this.exited(job, null, null); }
    });
    child.on("close", (code, signal) => { if (!done) { done = true; this.exited(job, code, signal); } });
    return { ok: true, data: null };
  }

  input(data: string): void { this.current?.pty?.write(data); }

  resize(cols: number, rows: number): void {
    try { this.current?.pty?.resize(cols, rows); } catch { /* a race with its exit */ }
  }

  /** Stops the running job (the page's Stop button, the page going away, quit). */
  cancel(): void {
    const c = this.current;
    if (!c) return;
    try { c.pty?.kill(); } catch { /* gone */ }
    try { c.child?.kill("SIGTERM"); } catch { /* gone */ }
    c.abort?.abort();
  }
}
