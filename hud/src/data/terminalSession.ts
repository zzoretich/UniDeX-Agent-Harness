// TerminalSession — wraps one terminal from the host (host.ts: the app's main process; node-pty under plain Node).
// Holds a circular scrollback buffer so xterm instances can be (re)attached at will, what the deck knows about the
// terminal (spec 2026-10-08-term-agent-deck §4: its host, place, origin, model, access, start and exit), and the title
// the program in it sets (termStream.ts), read from the raw stream so it works for terminals nobody is looking at.
// The host loads node-pty lazily, so a missing or broken install degrades to "terminals unavailable".
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
}

type DataListener = (data: string) => void;
type ExitListener = (info: { exitCode: number; signal?: number }) => void;
type UpdateListener = () => void;

const SCROLLBACK_CAP = 200_000;

export class TerminalSession {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;
  readonly meta: TerminalMeta;
  private pty: HostPtyProcess;
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

    this.pty = hostPty.spawn(opts.shell, [], {
      name: "xterm-256color",
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd,
      env: { ...(opts.env || {}), TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1", FORCE_HYPERLINK: "1" },
    });

    this.pty.onData((d: string) => {
      this.scrollback = (this.scrollback + d).slice(-SCROLLBACK_CAP);
      this.scan(d);
      for (const l of this.dataListeners) {
        try { l(d); } catch (err) { console.warn("[agentic-os] term data listener:", err); }
      }
    });
    this.pty.onExit((info: { exitCode: number; signal?: number }) => {
      this.exited = true;
      this.code = info.exitCode;
      for (const l of this.exitListeners) {
        try { l(info); } catch { /* ignore */ }
      }
      this.changed();
    });
  }

  get isExited(): boolean { return this.exited; }
  /** The exit code once the terminal has ended: the agent's own when it was started with exec. */
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
    if (this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try { this.pty.resize(cols, rows); } catch { /* race on exit */ }
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
    try { this.pty.kill(); } catch { /* ignore */ }
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
    if (this.meta.host === "shell") return false;
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
