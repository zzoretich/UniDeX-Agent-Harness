import { Events } from "obsidian";
import { pty as hostPty, type HostPtyAgentResult } from "../host";
import { TerminalSession, TerminalSessionOptions, type TerminalMeta } from "./terminalSession";
import { TERM_HOST_LABEL, launchArgs, launchLine, placeKey, type LaunchSpec, type Place } from "./terminalLaunch";

/** How a Code launch's terminal started (agent-computer D18): the agent as its own process, or the fallback shell with
 *  the launch line typed, and main's reason for that (null when there is nothing to say: a host with no agents). */
export interface AgentStart { agent: boolean; reason: string | null }

/** What main's pty:spawn-agent schema takes: a label and a place key, and a terminal size. */
const LABEL_MAX = 200;
const PLACE_MAX = 512;
const SIZE_MAX = 1000;

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
   * with the reason in it and rejects `ready`, as does a terminal closed before it started. What main's schema would
   * refuse never blocks the launch: the label is cut to fit, and a place key too long for it falls back without asking.
   * Throws before any terminal opens when the spec holds a value launchArgs refuses. R79, R80: with `onFlags`, when main
   * refuses the line because its `--no-daemon` disagrees with main's answer now, `onFlags` gets that answer (the launcher
   * keeps it, so its preview follows) and main is asked once more for the same terminal with the same spec, only its
   * `noDaemon` and `probedBin` changed; a second refusal ends it.
   */
  createAgent(o: { spec: LaunchSpec; place: Place; meta: Partial<TerminalMeta>; shell?: string; onFlags?: (flags: { noDaemon: boolean; bin: string | null }) => void }): { session: TerminalSession; ready: Promise<AgentStart> } {
    // A value launchArgs refuses throws here, before any terminal opens.
    launchArgs(o.spec);
    let spec = o.spec;
    const label = TERM_HOST_LABEL[o.spec.host];
    const session = this.create({ shell: o.shell, cwd: o.place.dir, meta: o.meta, deferred: true });
    const fit = (n: number): number => Math.min(Math.max(1, Math.floor(n) || 1), SIZE_MAX);
    const size = { cols: fit(session.dimensions.cols), rows: fit(session.dimensions.rows) };
    const place = placeKey(o.place);
    const ask = (s: LaunchSpec): Promise<HostPtyAgentResult> => (place.length > PLACE_MAX
      ? Promise.resolve({ ok: false as const, error: "this folder's path is too long for the computer", code: "fallback" })
      : hostPty.spawnAgent({
        host: s.host, argv: launchArgs(s), cwd: o.place.dir, configDir: s.configDir ?? null, gitInit: !!s.gitInit,
        cols: size.cols, rows: size.rows, place, label: `${label} in ${o.place.label}`.slice(0, LABEL_MAX), access: s.access,
      }));
    const asked = ask(spec).then(async (r) => {
      if (r.ok || r.code !== "flags" || !("flags" in r) || !o.onFlags || session.isClosed) return r;
      o.onFlags(r.flags);
      spec = { ...spec, noDaemon: r.flags.noDaemon, probedBin: r.flags.bin };
      return ask(spec);
    });
    const ready = asked.then((r): AgentStart => {
      const line = launchLine(spec);
      if (session.isClosed) {
        if (r.ok) { try { r.data.kill(); } catch { /* gone */ } }
        throw new Error(`${label} did not start: the terminal was closed`);
      }
      if (r.ok) { session.attachAgent(r.data, size); return { agent: true, reason: null }; }
      if (r.code !== "fallback") throw new Error(`${label} did not start: ${r.error}`);
      session.startShell(`${line}\r`);
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
