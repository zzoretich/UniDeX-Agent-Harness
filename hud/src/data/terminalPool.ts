import { Events } from "obsidian";
import { TerminalSession, TerminalSessionOptions } from "./terminalSession";

/**
 * Every terminal of the HUD, shared by the Term tab and the Pulse strip. Events: session-add (session), session-remove
 * (id), session-exit (session), session-update (session: its title, what the deck knows, or its exit changed) and
 * session-select (id or null: the terminal the Term tab shows, kept here so it survives a tab switch).
 */
export class TerminalPool extends Events {
  private sessions: Map<string, TerminalSession> = new Map();
  private counter = 0;
  private selected: string | null = null;
  /** The last launch from the deck and when, so a Term panel that mounts right after it still shows "Started …". */
  lastLaunch: { id: string; text: string; why: string; host: string; at: number } | null = null;

  defaults: { shell: string; cwd: string };

  constructor(defaults: { shell: string; cwd: string }) {
    super();
    this.defaults = defaults;
  }

  list(): TerminalSession[] { return [...this.sessions.values()]; }
  get(id: string): TerminalSession | undefined { return this.sessions.get(id); }

  create(overrides?: Partial<TerminalSessionOptions>): TerminalSession {
    const id = String(++this.counter);
    const opts: TerminalSessionOptions = {
      id,
      shell: overrides?.shell || this.defaults.shell,
      cwd: overrides?.cwd || this.defaults.cwd,
      env: overrides?.env,
      cols: overrides?.cols,
      rows: overrides?.rows,
      meta: overrides?.meta,
    };
    const sess = new TerminalSession(opts);
    sess.onExit(() => {
      // keep in pool so user can see exit; UI offers a re-spawn / close action
      this.trigger("session-exit", sess);
    });
    sess.onUpdate(() => { this.trigger("session-update", sess); });
    this.sessions.set(id, sess);
    this.trigger("session-add", sess);
    return sess;
  }

  /** The terminal the Term tab shows: the selected one while it exists, else the first. */
  selectedId(): string | null {
    if (this.selected && this.sessions.has(this.selected)) return this.selected;
    return this.list()[0]?.id ?? null;
  }

  select(id: string | null): void {
    const next = id && this.sessions.has(id) ? id : null;
    if (next === this.selected) return;
    this.selected = next;
    this.trigger("session-select", next);
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.dispose();
    this.sessions.delete(id);
    if (this.selected === id) this.selected = null;
    this.trigger("session-remove", id);
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      try { s.dispose(); } catch { /* ignore */ }
    }
    this.sessions.clear();
    this.selected = null;
  }
}
