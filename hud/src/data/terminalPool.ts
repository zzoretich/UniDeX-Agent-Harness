import { Events } from "obsidian";
import { pty as hostPty } from "../host";
import { TerminalSession, TerminalSessionOptions, type TerminalMeta } from "./terminalSession";
import { TERM_HOST_LABEL, launchArgs, launchLine, placeKey, type LaunchSpec, type Place } from "./terminalLaunch";

/** How a Code launch's terminal started (agent-computer D18): the agent as its own process, or the fallback shell with
 *  the launch line typed, and main's reason for that (null when there is nothing to say: a host with no agents). */
export interface AgentStart { agent: boolean; reason: string | null }

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
      deferred: overrides?.deferred,
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

  /**
   * A Code launch's terminal (agent-computer D18): it is in the deck at once, starting, while main runs the agent's CLI
   * as its own process, so main holds the CLI's pid for the computer bridge. When main falls back (an install it cannot
   * vouch for, an old runtime, no peer addon), the terminal gets the login shell with the launch line typed, as before,
   * and `ready` carries main's reason. A refusal (the folder, the words), or no shell to fall back to, ends the terminal
   * with the reason in it and rejects `ready`. Throws before any terminal opens when the spec holds a value launchArgs
   * refuses.
   */
  createAgent(o: { spec: LaunchSpec; place: Place; meta: Partial<TerminalMeta>; shell?: string }): { session: TerminalSession; ready: Promise<AgentStart> } {
    const argv = launchArgs(o.spec);
    const line = launchLine(o.spec);
    const label = TERM_HOST_LABEL[o.spec.host];
    const session = this.create({ shell: o.shell, cwd: o.place.dir, meta: o.meta, deferred: true });
    const size = session.dimensions;
    const ready = hostPty.spawnAgent({
      host: o.spec.host, argv, cwd: o.place.dir, configDir: o.spec.configDir ?? null, gitInit: !!o.spec.gitInit,
      cols: size.cols, rows: size.rows, place: placeKey(o.place), label: `${label} in ${o.place.label}`, access: o.spec.access,
    }).then((r): AgentStart => {
      if (r.ok) { session.attachAgent(r.data, size); return { agent: true, reason: null }; }
      if (r.code !== "fallback") throw new Error(`${label} did not start: ${r.error}`);
      session.startShell();
      session.write(`${line}\r`);
      return { agent: false, reason: r.error || null };
    }).catch((err: unknown) => {
      session.fail(err instanceof Error ? err.message : String(err));
      throw err;
    });
    return { session, ready };
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
