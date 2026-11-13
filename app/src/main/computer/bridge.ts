// The computer bridge (agent-computer D18, D26): a Unix socket in the app's userData that the agenticos MCP servers of
// agent CLIs connect to. Newline-delimited JSON. The first line must be {"hello":1}; the peer is then judged by `admit`
// (which also claims the agent's one connection) and answered {"admitted":true,"session":<label>} or
// {"admitted":false,"reason":…} and closed; the admitted answer also lists the tool names this app takes (`tools`). After that ToolCall lines flow and replies match by id, overlapping up to four
// at a time per connection (a fifth is answered at once with an error).
// Anything unexpected closes that one connection without a reply; no connection's failure reaches another or main. An
// agent that leaves the app's registry loses its connection (`drop`), and a call from one no longer live is refused (M12).

import net from "node:net";
import type { Admit } from "./admission";
import { listenPrivate, socketPathIn, unlinkIfBound } from "./unix-socket";
import { socketFd, type PeerAddon } from "./peer";
import type { AgentRef } from "./registry";
import { REFUSAL } from "./refusals";

export type ComputerTool = "computer_status" | "computer_open" | "computer_snapshot" | "computer_screenshot" | "computer_click" | "computer_type" | "computer_key" | "computer_scroll" | "computer_wait" | "computer_tab" | "computer_nav" | "computer_hover" | "computer_console";
export interface ToolCall { id: number; tool: ComputerTool; args: Record<string, unknown> }
export interface ToolReply { id: number; text: string; image?: { data: string; mimeType: "image/png" }; isError?: boolean }

/** The names this app takes, in the order the admission answer lists them (session-browser S16, Task 20: the runtime and the
 *  app update separately, so the runtime sends a tool only when the app named it). */
const TOOL_NAMES: readonly ComputerTool[] = ["computer_status", "computer_open", "computer_snapshot", "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_wait", "computer_tab", "computer_nav", "computer_hover", "computer_console"];
const TOOLS: ReadonlySet<string> = new Set<string>(TOOL_NAMES);
export { MAX_PATH_BYTES } from "./unix-socket";
const MAX_LINE_BYTES = 1024 * 1024;
/** Calls in flight per connection (agent-computer D18, backpressure): another is answered at once and never reaches the
 *  service, so one agent cannot queue unbounded work behind the wheel. */
const MAX_IN_FLIGHT = 4;

/**
 * Where the bridge listens: `<userData>/computer/bridge.sock`, or, when that is too long for a Unix socket (a long home
 * folder), a short path of this data folder's own in the user's system temp folder (`tmp`: macOS's per-user 0700
 * `$TMPDIR`), which the bridge creates and checks as it does the default one. Null when even that does not fit.
 */
export function bridgeSocketPath(userData: string, tmp: string): string | null {
  return socketPathIn(userData, tmp, "bridge.sock");
}

export interface BridgeOptions {
  socketPath: string;
  admit: (peerPid: number) => Admit;
  peer: PeerAddon;
  handle: (agent: AgentRef, call: ToolCall) => Promise<Omit<ToolReply, "id">>;
  onClose: (agent: AgentRef) => void;
  /** Whether an admitted agent is still the one the app registered (M12): a call from one that is not is refused and
   *  closes its connection. Absent, every admitted agent counts as live. */
  live?: (agent: AgentRef) => boolean;
  /** How long a connection may stay silent before its hello is answered (5 s; tests shorten it). */
  helloMs?: number;
}

export class ComputerBridge {
  private server: net.Server | null = null;
  private bound: { dev: number; ino: number } | null = null;
  private readonly conns = new Set<net.Socket>();
  /** Each admitted connection's close, by its agent's pid (M12: `drop`). */
  private readonly admitted = new Map<number, () => void>();

  constructor(private readonly o: BridgeOptions) {}

  /** Closes the connection admitted for `pid`: its agent left the registry (M12). Its onClose fires as for any close. */
  drop(pid: number): void { this.admitted.get(pid)?.(); }

  async start(): Promise<void> {
    const server = net.createServer((s) => this.connection(s));
    server.on("error", () => {});
    this.bound = await listenPrivate(server, this.o.socketPath, "the bridge");
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.conns) s.destroy();
    if (server) await new Promise<void>((res) => server.close(() => res()));
    const bound = this.bound;
    this.bound = null;
    unlinkIfBound(this.o.socketPath, bound);
  }

  private connection(sock: net.Socket): void {
    this.conns.add(sock);
    let agent: AgentRef | null = null;
    let hello = false;
    let buf = "";
    let done = false;
    let inFlight = 0;
    sock.setEncoding("utf8");   // a StringDecoder: a character split across reads is kept whole
    const timer = setTimeout(() => end(), this.o.helloMs ?? 5000);
    const end = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.conns.delete(sock);
      if (agent && this.admitted.get(agent.pid) === end) this.admitted.delete(agent.pid);
      sock.destroy();
      if (agent) { try { this.o.onClose(agent); } catch { /* a later task's cleanup must not break the bridge */ } }
    };
    const write = (o: unknown): void => { if (!done && !sock.destroyed) sock.write(`${JSON.stringify(o)}\n`); };
    const onLine = (line: string): void => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return end(); }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return end();
      if (!hello) {
        if (msg.hello !== 1) return end();
        hello = true;
        clearTimeout(timer);
        let verdict: Admit;
        try { verdict = this.o.admit(this.o.peer.peerPid(socketFd(sock))); }
        catch { verdict = { ok: false, reason: REFUSAL.notStarted }; }
        if (!verdict.ok) { write({ admitted: false, reason: verdict.reason }); sock.end(); return; }
        agent = verdict.agent;
        this.admitted.set(agent.pid, end);
        write({ admitted: true, session: agent.label, tools: TOOL_NAMES });
        return;
      }
      if (!agent || typeof msg.id !== "number" || !Number.isFinite(msg.id) || typeof msg.tool !== "string" || !TOOLS.has(msg.tool)) return end();
      const who = agent;
      const call: ToolCall = { id: msg.id, tool: msg.tool as ComputerTool, args: msg.args !== null && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {} };
      // M12: an agent that has left the registry (its CLI exited, its terminal closed) gets no more of the computer.
      let alive = true;
      try { alive = this.o.live ? this.o.live(who) : true; } catch { alive = false; }
      if (!alive) { write({ id: call.id, text: REFUSAL.ended, isError: true } satisfies ToolReply); sock.end(); end(); return; }
      if (inFlight >= MAX_IN_FLIGHT) { write({ id: call.id, text: REFUSAL.tooMany, isError: true } satisfies ToolReply); return; }
      inFlight++;
      void (async () => {
        try {
          write({ id: call.id, ...(await this.o.handle(who, call)) } as ToolReply);
        } catch (err) {
          try { write({ id: call.id, text: REFUSAL.computerFailed(err instanceof Error ? err.message : String(err)), isError: true }); } catch { end(); }
        } finally {
          inFlight--;
        }
      })();
    };
    sock.on("error", end);
    sock.on("close", end);
    sock.on("data", (d: string) => {
      try {
        buf += d;
        let i: number;
        while (!done && (i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) return end();
          onLine(line);
        }
        if (!done && Buffer.byteLength(buf) > MAX_LINE_BYTES) end();
      } catch { end(); }
    });
  }
}

/**
 * Keeps at most one bridge running, for the vault it should serve (agent-computer D18, D26). `sync(root)` starts one for
 * `root`; keeps a running one for the same vault (each CLI connects once and cannot reconnect, so a restart would drop
 * them); replaces one for another vault; and stops it for null (no vault, the `computer` surface off, or no peer addon).
 * One change at a time, in order; a bridge that fails to start is logged and the next sync tries again.
 */
export class BridgeKeeper {
  private running: { root: string; bridge: { stop(): Promise<void> } } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly log: (m: string) => void;

  /** `onFail`: the bridge for `root` did not start (the app records it, so the agents' tools can say so). */
  constructor(private readonly o: { make: (root: string) => Promise<{ stop(): Promise<void> }>; log?: (message: string) => void; onFail?: (root: string, error: unknown) => void }) {
    this.log = o.log ?? ((m) => console.warn(`[main] ${m}`));
  }

  /** The vault the running bridge serves, or null. */
  get root(): string | null { return this.running?.root ?? null; }

  sync(root: string | null): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.running && this.running.root === root) return;
      const old = this.running;
      this.running = null;
      try { await old?.bridge.stop(); } catch (e) { this.log(`the computer bridge did not stop cleanly: ${e instanceof Error ? e.message : String(e)}`); }
      if (root === null) return;
      try { this.running = { root, bridge: await this.o.make(root) }; }
      catch (e) {
        this.log(`the computer bridge did not start: ${e instanceof Error ? e.message : String(e)}`);
        try { this.o.onFail?.(root, e); } catch { /* the record is best effort */ }
      }
    });
    return this.chain;
  }
}
