// The computer bridge (agent-computer D18, D26): a Unix socket in the app's userData that the agenticos MCP servers of
// agent CLIs connect to. Newline-delimited JSON. The first line must be {"hello":1}; the peer is then judged by `admit`
// (which also claims the agent's one connection) and answered {"admitted":true,"session":<label>} or
// {"admitted":false,"reason":…} and closed. After that ToolCall lines flow and replies match by id, overlapping up to four
// at a time per connection (a fifth is answered at once with an error).
// Anything unexpected closes that one connection without a reply; no connection's failure reaches another or main.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Admit } from "./admission";
import { socketFd, type PeerAddon } from "./peer";
import type { AgentRef } from "./registry";

export type ComputerTool = "computer_status" | "computer_open" | "computer_snapshot" | "computer_screenshot" | "computer_click" | "computer_type" | "computer_key" | "computer_scroll" | "computer_wait";
export interface ToolCall { id: number; tool: ComputerTool; args: Record<string, unknown> }
export interface ToolReply { id: number; text: string; image?: { data: string; mimeType: "image/png" }; isError?: boolean }

const TOOLS: ReadonlySet<string> = new Set<ComputerTool>(["computer_status", "computer_open", "computer_snapshot", "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_wait"]);
/** sockaddr_un.sun_path holds 104 bytes on macOS, the last for the terminator. */
const MAX_PATH_BYTES = 103;
const MAX_LINE_BYTES = 1024 * 1024;
/** Calls in flight per connection (agent-computer D18, backpressure): another is answered at once and never reaches the
 *  service, so one agent cannot queue unbounded work behind the wheel. */
const MAX_IN_FLIGHT = 4;
const TOO_MANY = "Too many computer calls at once: wait for one to finish.";
const REFUSED = "Not started by UniDeX: start this session from the Code page's New menu or a Chat thread.";

export interface BridgeOptions {
  socketPath: string;
  admit: (peerPid: number) => Admit;
  peer: PeerAddon;
  handle: (agent: AgentRef, call: ToolCall) => Promise<Omit<ToolReply, "id">>;
  onClose: (agent: AgentRef) => void;
  /** How long a connection may stay silent before its hello is answered (5 s; tests shorten it). */
  helloMs?: number;
}

export class ComputerBridge {
  private server: net.Server | null = null;
  private bound: { dev: number; ino: number } | null = null;
  private readonly conns = new Set<net.Socket>();

  constructor(private readonly o: BridgeOptions) {}

  async start(): Promise<void> {
    const { socketPath } = this.o;
    if (Buffer.byteLength(socketPath) > MAX_PATH_BYTES) throw new Error(`the bridge socket path is longer than ${MAX_PATH_BYTES} bytes: ${socketPath}`);
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // Only a leftover socket is replaced; a file, link or folder at the path is somebody's, so refuse.
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(socketPath); } catch { /* nothing there */ }
    if (st) {
      if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket, so the bridge will not replace it`);
      fs.unlinkSync(socketPath);
    }
    const server = net.createServer((s) => this.connection(s));
    server.on("error", () => {});
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(socketPath, () => { server.off("error", rej); res(); });
    });
    try {
      fs.chmodSync(socketPath, 0o600);
      const b = fs.lstatSync(socketPath);
      this.bound = { dev: b.dev, ino: b.ino };
    } catch (err) {
      await new Promise<void>((res) => server.close(() => res()));
      throw err;
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.conns) s.destroy();
    if (server) await new Promise<void>((res) => server.close(() => res()));
    // libuv unlinks by name on close; make sure of it, but only if the path is still the socket this bridge bound.
    const bound = this.bound;
    this.bound = null;
    try {
      const now = fs.lstatSync(this.o.socketPath);
      if (bound && now.dev === bound.dev && now.ino === bound.ino) fs.unlinkSync(this.o.socketPath);
    } catch { /* already gone */ }
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
        catch { verdict = { ok: false, reason: REFUSED }; }
        if (!verdict.ok) { write({ admitted: false, reason: verdict.reason }); sock.end(); return; }
        agent = verdict.agent;
        write({ admitted: true, session: agent.label });
        return;
      }
      if (!agent || typeof msg.id !== "number" || !Number.isFinite(msg.id) || typeof msg.tool !== "string" || !TOOLS.has(msg.tool)) return end();
      const who = agent;
      const call: ToolCall = { id: msg.id, tool: msg.tool as ComputerTool, args: msg.args !== null && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {} };
      if (inFlight >= MAX_IN_FLIGHT) { write({ id: call.id, text: TOO_MANY, isError: true } satisfies ToolReply); return; }
      inFlight++;
      void (async () => {
        try {
          write({ id: call.id, ...(await this.o.handle(who, call)) } as ToolReply);
        } catch (err) {
          try { write({ id: call.id, text: `The computer failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }); } catch { end(); }
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

  constructor(private readonly o: { make: (root: string) => Promise<{ stop(): Promise<void> }>; log?: (message: string) => void }) {
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
      catch (e) { this.log(`the computer bridge did not start: ${e instanceof Error ? e.message : String(e)}`); }
    });
    return this.chain;
  }
}
