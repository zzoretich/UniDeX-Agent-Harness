// TerminalSession — wraps one terminal from the host (host.ts: the app's main process; node-pty under plain Node).
// Holds a circular scrollback buffer so xterm instances can be (re)attached at will, what the deck knows about the
// terminal (spec 2026-10-08-term-agent-deck §4: its host, place, origin, model, access, start and exit), and the title
// the program in it sets (termStream.ts), read from the raw stream so it works for terminals nobody is looking at.
// The host loads node-pty lazily, so a missing or broken install degrades to "terminals unavailable".
//
// A Code launch's terminal (agent-computer D18) starts with no process: the pool asks main to run the agent CLI as the
// terminal's own process and attaches it (attachAgent), or the shell when main falls back (startShell). What is typed
// meanwhile waits. When the agent exits, the user's login shell takes over in the same terminal and folder; the
// terminal ends only when that shell does.
import * as path from "path";
import { pty as hostPty, type HostPtyProcess } from "../host";
import { TermStreamScanner } from "./termStream";
import type { Place, TermAccess, TermHost } from "./terminalLaunch";
import { TERM_HOST_LABEL } from "./terminalLaunch";

/** What the deck knows about a terminal besides its output. */
export interface TerminalMeta {
  host: TermHost;
  /** Where it runs, as the deck resolved it; null for a terminal started without one (its cwd decides). */
  place: Place | null;
  /** What started it when it was not the deck: "Skills", "Settings" … (the row's subtitle). */
  origin: string | null;
  /** The name to show until the program sets a title: a host's name, or the command an app button ran. */
  label: string | null;
  model: string | null;
  access: TermAccess | null;
  /** The conversation's id when the deck knows it, on either host: the id it gave a new Claude Code conversation, or
   *  the one a resume by id named (a Codex thread included), so the end bar's Resume can name it again
   *  (spaces-redesign D7). Nothing persists it. */
  sessionId: string | null;
  startedAt: number;
}

export interface TerminalSessionOptions {
  id: string;
  shell: string;
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  meta?: Partial<TerminalMeta>;
  /** Start with no process: a Code launch's agent or its fallback shell is attached once main answers (D18). */
  deferred?: boolean;
}

type DataListener = (data: string) => void;
type ExitListener = (info: { exitCode: number; signal?: number }) => void;
type UpdateListener = () => void;

const SCROLLBACK_CAP = 200_000;
/** What may wait for a starting terminal's process (keys typed while main starts the agent). */
const PENDING_CAP = 64 * 1024;

export class TerminalSession {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;
  readonly meta: TerminalMeta;
  /** The process the terminal shows: null while a Code launch starts (D18). */
  private pty: HostPtyProcess | null = null;
  private readonly env: Record<string, string> | undefined;
  private size: { cols: number; rows: number };
  private pending = "";
  private disposed = false;
  /** The agent ended and the login shell took over (D18): titles are the shell prompt's business again. */
  private agentEnded = false;
  private scrollback: string = "";
  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();
  private updateListeners = new Set<UpdateListener>();
  private exited = false;
  private code: number | null = null;
  private title: string | null = null;
  private scanner = new TermStreamScanner();
  /** Whether the program last said its prompt takes bracketed pastes (the composer sends one then). */
  pasteMode = false;

  constructor(opts: TerminalSessionOptions) {
    this.id = opts.id;
    this.shell = opts.shell;
    this.cwd = opts.cwd;
    this.meta = {
      host: opts.meta?.host ?? "shell",
      place: opts.meta?.place ?? null,
      origin: opts.meta?.origin ?? null,
      label: opts.meta?.label ?? null,
      model: opts.meta?.model ?? null,
      access: opts.meta?.access ?? null,
      sessionId: opts.meta?.sessionId ?? null,
      startedAt: opts.meta?.startedAt ?? Date.now(),
    };
    this.env = opts.env;
    this.size = { cols: opts.cols || 80, rows: opts.rows || 24 };
    if (!opts.deferred) this.attach(this.spawnShell(), false);
  }

  /** The user's login shell in this terminal's folder. Throws when terminals are unavailable or it is refused. */
  private spawnShell(): HostPtyProcess {
    return hostPty.spawn(this.shell, [], {
      name: "xterm-256color",
      cols: this.size.cols,
      rows: this.size.rows,
      cwd: this.cwd,
      env: { ...(this.env || {}), TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1", FORCE_HYPERLINK: "1" },
    });
  }

  /** Makes `p` the terminal's process; `spawned` is the size it started with, corrected if the terminal resized since. */
  private attach(p: HostPtyProcess, agent: boolean, spawned: { cols: number; rows: number } = this.size): void {
    this.pty = p;
    p.onData((d: string) => { if (this.pty === p) this.output(d, true); });
    p.onExit((info: { exitCode: number; signal?: number }) => {
      if (this.pty !== p) return;
      if (agent && !this.disposed) { this.agentExited(info); return; }
      this.pty = null;
      this.end(info);
    });
    if (spawned.cols !== this.size.cols || spawned.rows !== this.size.rows) {
      try { p.resize(this.size.cols, this.size.rows); } catch { /* race on exit */ }
    }
    if (this.pending) { const w = this.pending; this.pending = ""; p.write(w); }
  }

  /** The agent ended: the login shell takes over in the same folder (D18), or the terminal ends if it cannot start. */
  private agentExited(info: { exitCode: number; signal?: number }): void {
    this.pty = null;
    this.agentEnded = true;
    this.title = null;
    this.output(`\r\n\x1b[2m${TERM_HOST_LABEL[this.meta.host]} ended${info.exitCode ? ` (exit ${info.exitCode})` : ""}. This is your shell, in the same folder.\x1b[0m\r\n`, false);
    try { this.attach(this.spawnShell(), false); }
    catch (err) {
      this.output(`\x1b[2m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`, false);
      this.end(info);
      return;
    }
    this.changed();
  }

  private output(d: string, scan: boolean): void {
    this.scrollback = (this.scrollback + d).slice(-SCROLLBACK_CAP);
    if (scan) this.scan(d);
    for (const l of this.dataListeners) {
      try { l(d); } catch (err) { console.warn("[agentic-os] term data listener:", err); }
    }
  }

  private end(info: { exitCode: number; signal?: number }): void {
    this.exited = true;
    this.code = info.exitCode;
    for (const l of this.exitListeners) {
      try { l(info); } catch { /* ignore */ }
    }
    this.changed();
  }

  /** A deferred terminal's agent, which main started as its own process at `spawned` (the size it was asked for, D18).
   *  Killed at once if the terminal has gone. */
  attachAgent(p: HostPtyProcess, spawned: { cols: number; rows: number }): void {
    if (this.disposed || this.exited || this.pty) { try { p.kill(); } catch { /* gone */ } return; }
    this.attach(p, true, spawned);
  }

  /** A deferred terminal's shell, when main fell back (D18), with `first` (the launch line) typed into it before what
   *  was typed while it started, so that typeahead reaches the agent and never the line. Throws as a new terminal's
   *  shell would. */
  startShell(first = ""): void {
    if (this.disposed || this.exited || this.pty) return;
    const p = this.spawnShell();
    this.pending = first + this.pending;
    this.attach(p, false);
  }

  /** Closed (removed from the deck) before or after its process started. */
  get isClosed(): boolean { return this.disposed; }

  /** Ends a deferred terminal that got no process (main refused the agent, or no shell could start), saying why in it. */
  fail(message: string): void {
    if (this.disposed || this.exited || this.pty) return;
    this.output(`\x1b[31m${message}\x1b[0m\r\n`, false);
    this.end({ exitCode: 1 });
  }

  /** The size its next process starts with. */
  get dimensions(): { cols: number; rows: number } { return { ...this.size }; }

  get isExited(): boolean { return this.exited; }
  /** The exit code once the terminal has ended: its last process's, so the agent's own when its typed line exec'd it,
   *  and the login shell's after an agent main ran as the terminal's process (D18). */
  get exitCode(): number | null { return this.code; }

  /** The title the program set, else the label, else the host's name or the shell's (`zsh`). */
  getTitle(): string {
    return this.title || this.meta.label || (this.meta.host === "shell" ? path.basename(this.shell) || "shell" : TERM_HOST_LABEL[this.meta.host]);
  }
  setTitle(t: string): void { this.title = t || null; this.changed(); }

  /** Changes what the deck knows (after a move or a restart choice) and tells the listeners. */
  setMeta(patch: Partial<TerminalMeta>): void {
    Object.assign(this.meta, patch);
    this.changed();
  }

  getScrollback(): string { return this.scrollback; }

  write(data: string): void {
    if (this.exited || this.disposed) return;
    if (this.pty) this.pty.write(data);
    else this.pending = (this.pending + data).slice(-PENDING_CAP);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.size = { cols, rows };
    try { this.pty?.resize(cols, rows); } catch { /* race on exit */ }
  }

  onData(l: DataListener): () => void {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  /** Calls `l` when the title, what the deck knows, or the exit changes. */
  onUpdate(l: UpdateListener): () => void {
    this.updateListeners.add(l);
    return () => this.updateListeners.delete(l);
  }

  dispose(): void {
    this.disposed = true;
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.updateListeners.clear();
  }

  private scan(d: string): void {
    let titleChanged = false;
    for (const sig of this.scanner.feed(d)) {
      if (sig.bracketedPaste !== undefined) this.pasteMode = sig.bracketedPaste;
      if (sig.title !== undefined && this.titleWorthShowing(sig.title) && sig.title !== this.title) {
        this.title = sig.title;
        titleChanged = true;
      }
    }
    if (titleChanged) this.changed();
  }

  /** A shell's title is its prompt's business; Codex's default title is its spinner and the project folder, which says
   *  nothing the row does not, so both are kept out. */
  private titleWorthShowing(t: string): boolean {
    if (!t) return false;
    if (this.meta.host === "shell" || this.agentEnded) return false;
    return !(this.meta.host === "codex" && t === path.basename(this.meta.place?.dir ?? this.cwd));
  }

  private changed(): void {
    for (const l of this.updateListeners) {
      try { l(); } catch { /* ignore */ }
    }
  }
}

export function getPtyLoadError(): string | null {
  return hostPty.loadError();
}

export function isPtyAvailable(): boolean {
  return hostPty.loadError() === null;
}
