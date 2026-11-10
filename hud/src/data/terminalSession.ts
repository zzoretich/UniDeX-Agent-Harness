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
import { codeChatOn, pty as hostPty, type HostPtyProcess } from "../host";
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
  /** The terminal's key, a v4 UUID (code-chat R15): an agent terminal's PTY carries it as AOS_TERMINAL while the Code chat
   *  surface is on (F9), so the status line's copy and the Code chat's follower are named by it. A terminal made without
   *  one, or with one that is not a v4 UUID, gets a fresh key (F14). */
  terminalKey: string;
  /** False for a command an app button ran in an agent's name that is not a conversation (Connectors' `codex mcp
   *  login`): no chat view, no follower, no chat composer (R40). Absent: an agent terminal has its chat. */
  chat?: false;
}

/** Whether a terminal is a conversation with an agent: the chat view, its follower and its composer are for these. */
export function hasChat(meta: Pick<TerminalMeta, "host" | "chat">): boolean {
  return meta.host !== "shell" && meta.chat !== false;
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

const TERMINAL_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A new terminal key: a v4 UUID (Web Crypto, the page's and Node's). */
function newTerminalKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

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
  private endedAgent = false;
  /** The computer's name for the agent main runs here (agent-computer D35), kept after it ends. */
  private agentKey: string | null = null;
  /** The app's id for the terminal's first process (the agent main runs, or the shell it fell back to), kept for the
   *  terminal's life: the Code chat's follower is named by it, never by a takeover shell's (code-chat R28). */
  private firstPty: string | null = null;
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
      terminalKey: typeof opts.meta?.terminalKey === "string" && TERMINAL_KEY.test(opts.meta.terminalKey) ? opts.meta.terminalKey : newTerminalKey(),
      ...(opts.meta?.chat === false ? { chat: false as const } : {}),
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
      env: {
        ...(this.env || {}), TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1", FORCE_HYPERLINK: "1",
        // An agent terminal's shell (the launch line typed into it) hands its key to the agent it starts (code-chat R15),
        // while the Code chat surface is on (F9): off, the status line writes no per-terminal copy.
        ...(this.meta.host === "shell" || !codeChatOn() ? {} : { AOS_TERMINAL: this.meta.terminalKey }),
      },
    });
  }

  /** Makes `p` the terminal's process; `spawned` is the size it started with, corrected if the terminal resized since. */
  private attach(p: HostPtyProcess, agent: boolean, spawned: { cols: number; rows: number } = this.size): void {
    this.pty = p;
    const first = this.firstPty === null && typeof p.id === "string";
    if (first) this.firstPty = p.id as string;
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
    // A deferred terminal's first process came after the deck listed it: say so, so its chat can follow it now.
    if (first) this.changed();
  }

  /** The agent ended: the login shell takes over in the same folder (D18), or the terminal ends if it cannot start. */
  private agentExited(info: { exitCode: number; signal?: number }): void {
    this.pty = null;
    this.endedAgent = true;
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
    if (p.id) this.agentKey = `code:${p.id}`;
    this.attach(p, true, spawned);
  }

  /** The key the computer names this terminal's agent by (agent-computer D31, D35): `code:<the app's terminal id>`, once
   *  main runs the agent as the terminal's own process; null for a shell, a fallback, or a host without the app's ids.
   *  The Code rows' dot and "waiting" read a computer's holder and asks by it. */
  get computerKey(): string | null { return this.agentKey; }

  /** The agent exited and the login shell took over in its terminal (D18; code-chat R39): `meta.host` still names the
   *  agent (its end bar keeps Restart and Resume), but what runs and takes keys now is a shell, so the chat writes nothing
   *  into it. The deck hears it through onUpdate. */
  get agentEnded(): boolean { return this.endedAgent; }

  /** The app's id for the terminal's first process (code-chat R28): what its Code chat follows for the terminal's whole
   *  life, after a login shell took over too. Null while a Code launch starts, and on a host without the app's ids. */
  get originPty(): string | null { return this.firstPty; }

  /** The app's id for the process running in the terminal now (the agent, or the login shell after it): what code:git names
   *  so main reads git where that process started (code-chat C8). Null with no process, and on a host without the app's ids. */
  get ptyId(): string | null { return typeof this.pty?.id === "string" ? this.pty.id : null; }

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
    if (this.meta.host === "shell" || this.endedAgent) return false;
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
