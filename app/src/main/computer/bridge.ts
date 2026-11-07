// The computer bridge (agent-computer D18, D26): a Unix socket in the app's userData that the agenticos MCP servers of
// agent CLIs connect to. Newline-delimited JSON. The first line must be {"hello":1}; the peer is then judged by `admit`
// (which also claims the agent's one connection) and answered {"admitted":true,"session":<label>} or
// {"admitted":false,"reason":…} and closed. After that ToolCall lines flow and replies match by id, overlapping freely.
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
const REFUSED = "Not started by UniDeX: start this session from the Code page's New menu or a Chat thread.";

export interface BridgeOptions {
  socketPath: string;
  admit: (peerPid: number) => Admit;
  peer: PeerAddon;
  handle: (agent: AgentRef, call: ToolCall) => Promise<Omit<ToolReply, "id">>;
  onClose: (agent: AgentRef) => void;
}

export class ComputerBridge {
  private server: net.Server | null = null;
  private readonly conns = new Set<net.Socket>();

  constructor(private readonly o: BridgeOptions) {}

  async start(): Promise<void> {
    const { socketPath } = this.o;
    if (Buffer.byteLength(socketPath) > MAX_PATH_BYTES) throw new Error(`the bridge socket path is longer than ${MAX_PATH_BYTES} bytes: ${socketPath}`);
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    try { fs.unlinkSync(socketPath); } catch { /* none left over */ }
    const server = net.createServer((s) => this.connection(s));
    server.on("error", () => {});
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(socketPath, () => { server.off("error", rej); res(); });
    });
    fs.chmodSync(socketPath, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.conns) s.destroy();
    if (server) await new Promise<void>((res) => server.close(() => res()));
    try { fs.unlinkSync(this.o.socketPath); } catch { /* already gone */ }
  }

  private connection(sock: net.Socket): void {
    this.conns.add(sock);
    let agent: AgentRef | null = null;
    let hello = false;
    let buf = "";
    let done = false;
    const end = (): void => {
      if (done) return;
      done = true;
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
      void (async () => {
        let reply: ToolReply;
        try { reply = { id: call.id, ...(await this.o.handle(who, call)) }; }
        catch (err) { reply = { id: call.id, text: `The computer failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }; }
        write(reply);
      })();
    };
    sock.on("error", end);
    sock.on("close", end);
    sock.on("data", (d) => {
      try {
        buf += d.toString("utf8");
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
